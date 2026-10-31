#!/usr/bin/env node
/**
 * Bake KayKit Knight animations onto the Blade & Mount fighter rig.
 *
 *   node src/dev/bake-knight-anim.mjs [--in assets-src/Knight.glb] [--out public/assets/knight-anim.json] [--fps 30]
 *
 * Retarget maths (see docs/animation-research.md):
 *  - Our rig is a rigid-part SkinnedMesh whose bones all have identity rest
 *    rotations (geometry is authored in bone-local space). Its "bind pose" is
 *    therefore already a neutral standing stance.
 *  - For every source bone we compute its *world* orientation per frame with the
 *    source's own rest hierarchy, ignored for the `root` node (source root
 *    rotation/translation is locomotion/steering and is dropped).
 *  - A world-space delta is taken against a neutral reference pose (`Idle` at
 *    t=0): D = W(t) * W(ref)^-1.
 *  - The target bone world orientation is D (the rig's bind stance is the base),
 *    then converted to a *local* quaternion through our (identity-rest) target
 *    hierarchy: local = inv(D_parent) * D. This is a per-frame, per-bone local
 *    quaternion track; at runtime we slerp between keys and write Euler angles
 *    into the existing RigPose, so the current animator/render pipeline is reused.
 *  - Hips translation is stored as a raw delta from the reference pose; runtime
 *    scales it (vertical bob / horizontal weight shift / death collapse).
 *
 * No dependencies beyond `three` (not even imported here: GLB is parsed directly).
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const IN = arg('in', 'assets-src/Knight.glb');
const OUT = arg('out', 'public/assets/knight-anim.json');
const FPS = Number(arg('fps', '30'));

/* ------------------------------------------------------------------ */
/* GLB parsing                                                         */
/* ------------------------------------------------------------------ */

const buf = fs.readFileSync(IN);
let off = 12;
let json = null;
let bin = null;
const total = buf.readUInt32LE(8);
while (off < total) {
  const clen = buf.readUInt32LE(off);
  const ctype = buf.readUInt32LE(off + 4);
  const data = buf.subarray(off + 8, off + 8 + clen);
  if (ctype === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
  else if (ctype === 0x004e4942) bin = data;
  off += 8 + clen;
}
if (!json || !bin) throw new Error('not a GLB');

const CT_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function readAccessor(i) {
  const a = json.accessors[i];
  const bv = json.bufferViews[a.bufferView];
  const n = NC[a.type];
  const cs = CT_SIZE[a.componentType];
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const stride = bv.byteStride || n * cs;
  const readers = {
    5126: (o) => bin.readFloatLE(o),
    5123: (o) => bin.readUInt16LE(o),
    5125: (o) => bin.readUInt32LE(o),
    5121: (o) => bin.readUInt8(o),
    5122: (o) => bin.readInt16LE(o),
  };
  const read = readers[a.componentType];
  const out = new Array(a.count);
  for (let k = 0; k < a.count; k++) {
    if (n === 1) out[k] = read(base + k * stride);
    else {
      const row = new Array(n);
      for (let c = 0; c < n; c++) row[c] = read(base + k * stride + c * cs);
      out[k] = row;
    }
  }
  return out;
}

const nodes = json.nodes;
const nodeIndex = new Map(nodes.map((n, i) => [n.name, i]));
const parentOf = new Array(nodes.length).fill(-1);
nodes.forEach((n, i) => (n.children || []).forEach((c) => (parentOf[c] = i)));
const restLocal = nodes.map((n) => ({
  t: n.translation ? n.translation.slice() : [0, 0, 0],
  r: n.rotation ? n.rotation.slice() : [0, 0, 0, 1],
  s: n.scale ? n.scale.slice() : [1, 1, 1],
}));

const animByName = new Map(json.animations.map((a) => [a.name, a]));

/** node index -> { path -> { key times, values, interp } } for one clip. */
function clipChannels(anim) {
  const channels = new Map();
  for (const ch of anim.channels) {
    const s = anim.samplers[ch.sampler];
    const times = readAccessor(s.input);
    const values = readAccessor(s.output);
    const map = channels.get(ch.target.node) || {};
    map[ch.target.path] = { times, values, interp: s.interpolation || 'LINEAR' };
    channels.set(ch.target.node, map);
  }
  // clip time range from all samplers
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const s of anim.samplers) {
    const a = json.accessors[s.input];
    if (a.min) t0 = Math.min(t0, a.min[0]);
    if (a.max) t1 = Math.max(t1, a.max[0]);
  }
  return { channels, t0: Number.isFinite(t0) ? t0 : 0, t1: Number.isFinite(t1) ? t1 : 0 };
}

/* --- quaternion helpers (arrays [x,y,z,w]) --- */
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qconj = (a) => [-a[0], -a[1], -a[2], a[3]];
const qnorm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2], a[3]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l, a[3] / l];
};
const qdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
function qslerp(a, b, t) {
  let d = qdot(a, b);
  let bb = b;
  if (d < 0) {
    bb = [-b[0], -b[1], -b[2], -b[3]];
    d = -d;
  }
  if (d > 0.9995) {
    const r = [
      a[0] + (bb[0] - a[0]) * t,
      a[1] + (bb[1] - a[1]) * t,
      a[2] + (bb[2] - a[2]) * t,
      a[3] + (bb[3] - a[3]) * t,
    ];
    return qnorm(r);
  }
  const th = Math.acos(Math.min(1, d));
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
}

function sampleTrack(tr, t) {
  const { times, values } = tr;
  const n = times.length;
  if (n === 0) return null;
  if (n === 1 || t <= times[0]) return values[0].slice();
  if (t >= times[n - 1]) return values[n - 1].slice();
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo] || 1;
  const k = (t - times[lo]) / span;
  const a = values[lo];
  const b = values[hi];
  if (a.length === 4) return qslerp(a, b, k);
  return a.map((v, i) => v + (b[i] - v) * k);
}

/* ------------------------------------------------------------------ */
/* Source pose sampling                                                */
/* ------------------------------------------------------------------ */

/** World orientation per node index (root animation ignored). */
function sampleWorldQuats(channels, t, out = new Map()) {
  // resolve needs a topological walk; node order in the GLB is not hierarchical,
  // so walk from root and recurse.
  const root = nodeIndex.get('root');
  const qOf = new Map();
  const walk = (idx) => {
    const localRest = restLocal[idx].r;
    const ch = channels.get(idx);
    let local = localRest;
    if (ch && ch.rotation) {
      const q = sampleTrack(ch.rotation, t);
      if (q) local = q;
    }
    const parent = parentOf[idx];
    let world;
    if (idx === root || parent < 0) world = [0, 0, 0, 1]; // ignore root animation
    else {
      if (!qOf.has(parent)) walk(parent);
      world = qmul(qOf.get(parent), local);
    }
    qOf.set(idx, world);
    for (const c of nodes[idx].children || []) walk(c);
  };
  walk(root);
  void out;
  return qOf;
}

function sampleHipsTranslation(channels, t, rootLocalT) {
  const hips = nodeIndex.get('hips');
  const ch = channels.get(hips);
  const rest = restLocal[hips].t;
  if (ch && ch.translation) {
    const tv = sampleTrack(ch.translation, t);
    if (tv) return [tv[0], tv[1], tv[2]];
  }
  return [rest[0], rest[1], rest[2]];
}

/* ------------------------------------------------------------------ */
/* Mapping source bones -> our rig                                     */
/* ------------------------------------------------------------------ */

/**
 * Target bone order matters only for documentation: every target local
 * quaternion is computed from absolute world deltas, so the list is used for
 * output layout. Source node names, note `hand` is a child of `wrist`.
 */
const BONES = [
  ['hips', 'hips', null],
  ['spine', 'spine', 'hips'],
  ['chest', 'chest', 'spine'],
  ['head', 'head', 'chest'],
  ['shoulderR', 'upperarm.r', 'chest'],
  ['elbowR', 'lowerarm.r', 'shoulderR'],
  ['handR', 'hand.r', 'elbowR'],
  ['shoulderL', 'upperarm.l', 'chest'],
  ['elbowL', 'lowerarm.l', 'shoulderL'],
  ['handL', 'hand.l', 'elbowL'],
  ['thighR', 'upperleg.r', 'hips'],
  ['kneeR', 'lowerleg.r', 'thighR'],
  ['footR', 'foot.r', 'kneeR'],
  ['thighL', 'upperleg.l', 'hips'],
  ['kneeL', 'lowerleg.l', 'thighL'],
  ['footL', 'foot.l', 'kneeL'],
];

const CLIPS = {
  Idle:        { src: 'Idle',                          loop: true },
  Idle2H:      { src: '2H_Melee_Idle',                 loop: true },
  UnarmedIdle: { src: 'Unarmed_Idle',                  loop: true },
  Walk:        { src: 'Walking_A',                     loop: true },
  WalkB:       { src: 'Walking_B',                     loop: true },
  Run:         { src: 'Running_A',                     loop: true },
  RunB:        { src: 'Running_B',                     loop: true },
  StrafeL:     { src: 'Running_Strafe_Left',           loop: true },
  StrafeR:     { src: 'Running_Strafe_Right',          loop: true },
  Back:        { src: 'Walking_Backwards',             loop: true },
  Guard:       { src: 'Blocking',                      loop: true },
  Guard2H:     { src: 'Block',                         loop: true },
  GuardHit:    { src: 'Block_Hit',                     loop: false },
  AttackR:     { src: '1H_Melee_Attack_Slice_Diagonal', loop: false },
  AttackL:     { src: '1H_Melee_Attack_Slice_Horizontal', loop: false },
  AttackO:     { src: '1H_Melee_Attack_Chop',          loop: false },
  AttackT:     { src: '1H_Melee_Attack_Stab',          loop: false },
  AttackR2H:   { src: '2H_Melee_Attack_Slice',         loop: false },
  AttackL2H:   { src: '2H_Melee_Attack_Chop',          loop: false },
  AttackO2H:   { src: '2H_Melee_Attack_Chop',          loop: false },
  AttackT2H:   { src: '2H_Melee_Attack_Stab',          loop: false },
  Hit:         { src: 'Hit_A',                         loop: false },
  Stagger:     { src: 'Hit_B',                         loop: false },
  Kick:        { src: 'Unarmed_Melee_Attack_Kick',     loop: false },
  DodgeL:      { src: 'Dodge_Left',                    loop: false },
  DodgeR:      { src: 'Dodge_Right',                   loop: false },
  DodgeB:      { src: 'Dodge_Backward',                loop: false },
  DodgeF:      { src: 'Dodge_Forward',                 loop: false },
  DeathA:      { src: 'Death_A',                       loop: false, clamp: true },
  DeathB:      { src: 'Death_B',                       loop: false, clamp: true },
  Cheer:       { src: 'Cheer',                         loop: false, clamp: true },
};

const REF_CLIP = 'Idle';
const srcIds = BONES.map(([, src]) => nodeIndex.get(src));
if (srcIds.some((i) => i === undefined)) throw new Error('missing source bone');

// Reference world quats sampled from Idle t=0.
const refAnim = animByName.get(CLIPS[REF_CLIP].src);
const refInfo = clipChannels(refAnim);
const refWorld = sampleWorldQuats(refInfo.channels, refInfo.t0);
const refHipsT = sampleHipsTranslation(refInfo.channels, refInfo.t0);
const refQ = BONES.map(([, src]) => refWorld.get(nodeIndex.get(src)));

const out = {
  source: path.basename(IN),
  fps: FPS,
  reference: REF_CLIP,
  note: 'Retargeted local bone quaternions for the procedural rig; hips = translation delta from reference pose (metres, unscaled).',
  bones: BONES.map(([name, src]) => `${name}<-${src}`),
  clips: {},
};

const stats = [];
for (const [name, cfg] of Object.entries(CLIPS)) {
  const anim = animByName.get(cfg.src);
  if (!anim) throw new Error(`missing animation ${cfg.src}`);
  const info = clipChannels(anim);
  const dur = info.t1 - info.t0;
  const nFrames = Math.max(1, Math.round(dur * FPS));
  const frameCount = cfg.loop ? nFrames : nFrames + 1;
  const tracks = {};
  for (const [b] of BONES) tracks[b] = new Float32Array(frameCount * 4);
  const hips = new Float32Array(frameCount * 3);
  let prev = BONES.map(() => null);

  for (let f = 0; f < frameCount; f++) {
    const t = info.t0 + Math.min(f, nFrames) / FPS; // loop clips never sample the duplicate end frame
    const world = sampleWorldQuats(info.channels, t);
    const D = new Map();
    for (let i = 0; i < BONES.length; i++) {
      const w = world.get(srcIds[i]);
      D.set(BONES[i][0], qmul(w, qconj(refQ[i])));
    }
    const localOf = new Map();
    for (const [bone, , parent] of BONES) {
      const d = D.get(bone);
      const pq = parent ? D.get(parent) : [0, 0, 0, 1]; // our `body` joint has identity rest
      let local = qnorm(qmul(qconj(pq), d));
      const pi = BONES.findIndex((x) => x[0] === bone);
      if (prev[pi]) {
        // keep quaternion sign continuous for clean slerp
        if (qdot(prev[pi], local) < 0) local = [-local[0], -local[1], -local[2], -local[3]];
      }
      prev[pi] = local;
      localOf.set(bone, local);
    }
    for (const [bone] of BONES) {
      const q = localOf.get(bone);
      const o = f * 4;
      tracks[bone][o] = q[0];
      tracks[bone][o + 1] = q[1];
      tracks[bone][o + 2] = q[2];
      tracks[bone][o + 3] = q[3];
    }
    const ht = sampleHipsTranslation(info.channels, t);
    hips[f * 3] = ht[0] - refHipsT[0];
    hips[f * 3 + 1] = ht[1] - refHipsT[1];
    hips[f * 3 + 2] = ht[2] - refHipsT[2];
  }

  // round for compactness
  const round = (v, d = 5) => Number(v.toFixed(d));
  const clipOut = {
    src: cfg.src,
    dur: Number((frameCount / FPS).toFixed(4)),
    loop: !!cfg.loop,
    clamp: !!cfg.clamp,
    frames: frameCount,
    hips: Array.from(hips, (v) => round(v, 4)),
    tracks: {},
  };
  for (const [bone] of BONES) {
    clipOut.tracks[bone] = Array.from(tracks[bone], (v) => round(v, 5));
  }
  out.clips[name] = clipOut;
  stats.push({ name, src: cfg.src, frames: frameCount, dur: clipOut.dur });
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
const bytes = fs.statSync(OUT).size;
console.log(`baked ${stats.length} clips -> ${OUT} (${(bytes / 1024).toFixed(1)} KB)`);
for (const s of stats) console.log(`  ${s.name.padEnd(12)} ${s.src.padEnd(28)} ${String(s.frames).padStart(3)}f ${s.dur.toFixed(2)}s`);

// quick sanity dump of a few neutral-pose locals (should be near identity for
// hips/spine at reference t=0 etc.)
{
  const idle = out.clips.Idle;
  const q = (b, f = 0) => idle.tracks[b].slice(f * 4, f * 4 + 4).map((v) => v.toFixed(3)).join(',');
  console.log('sanity Idle f0 local hips:', q('hips'), 'spine:', q('spine'), 'shoulderR:', q('shoulderR'));
  const walk = out.clips.Walk;
  const knee = [];
  for (let f = 0; f < walk.frames; f++) knee.push(walk.tracks.kneeR[f * 4 + 3]);
  console.log('sanity Walk kneeR w range', Math.min(...knee).toFixed(3), Math.max(...knee).toFixed(3));
  const hipY = [];
  for (let f = 0; f < walk.frames; f++) hipY.push(walk.hips[f * 3 + 1]);
  console.log('sanity Walk hips dy range', Math.min(...hipY).toFixed(3), Math.max(...hipY).toFixed(3));
  const death = out.clips.DeathA;
  const dh = [];
  for (let f = 0; f < death.frames; f++) dh.push([death.hips[f * 3], death.hips[f * 3 + 1], death.hips[f * 3 + 2]].map((v) => v.toFixed(2)).join(','));
  console.log('sanity DeathA hips first/last', dh[0], dh[dh.length - 1]);
}
