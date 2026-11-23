import "./hud/hud.css";
import { courtyard } from "./render/map";
import { World, type PlayerDims, type Team } from "./render/scene";
import { FixedLoop, FpsMeter, type FpsCap } from "./game/loop";
import { InputCapture } from "./game/input";
import { NetGraph, type Row } from "./hud/netgraph";
import { Scorecard, Banner, el } from "./hud/widgets";
import { LabPanel, type LabBackend } from "./hud/lab";
import type { ModeState } from "./hud/scorecard";
import { loadSim, type NetcodeSim } from "./net/wasm";
import { fetchInfo, WsTransport, WtTransport, webTransportPossible, type Transport } from "./net/transport";
import { Session } from "./net/session";
import { loadAssets } from "./render/assets";
import { PresenterView } from "./hud/presenter";
import { mountPerf } from "./hud/perf";
import { mountWire } from "./hud/wire";
import { PRESET_DOCS, conceptUrl } from "./hud/presets";
import { Sfx } from "./audio";
import { ShotVfx } from "./render/vfx";
import { CombatHud } from "./hud/combat";
import { HIT_HEAD, toVec, type ScoreRow, type ShotEvent, type DeathEvent, type Vec3 } from "./game/events";
import { HitboxOverlay } from "./render/hitboxes";
import { DeathReplay } from "./hud/deathReplay";
import * as THREE from "three";

// B.3: 600 rpm. Cosmetic cadence only; the server decides which shots exist.
const FIRE_INTERVAL_MS = 100;

const hud = document.body;
const offlineBackend: LabBackend = { connected: false, builtPresets: new Set(), settings: null, activePreset: null, applyPreset() {}, setSetting() {} };

interface Link { sim: NetcodeSim | null; session: Session | null; transportNote: string; problems: string[] }

async function connect(): Promise<Link> {
  const link: Link = { sim: null, session: null, transportNote: "", problems: [] };
  try { link.sim = await loadSim(); } catch (e) { link.problems.push(`Shared sim (WASM): ${(e as Error).message}`); }
  let info;
  try { info = await fetchInfo(); } catch (e) { link.problems.push(`Game server: ${(e as Error).message}`); }
  if (!link.sim || !info) return link;
  if (info.protocolVersion !== link.sim.protocolVersion) {
    link.problems.push(`protocol mismatch: server ${info.protocolVersion}, sim.wasm ${link.sim.protocolVersion}`);
    return link;
  }
  let t: Transport | null = null;
  const forceWs = new URLSearchParams(location.search).get("transport") === "ws";
  if (forceWs) link.transportNote = "forced by ?transport=ws";
  else if (webTransportPossible() && info.wt) {
    try { t = await WtTransport.connect(info); }
    catch (e) { link.transportNote = `WebTransport failed (${(e as Error).message})`; }
  } else {
    link.transportNote = !window.isSecureContext ? "page is plain HTTP, not a secure context" : !info.wt ? "server offers no WebTransport" : "this browser has no WebTransport";
  }
  if (!t) {
    try { t = await WsTransport.connect(info.ws); }
    catch (e) { link.problems.push(`Game server: ${(e as Error).message}`); return link; }
  }
  const name = new URLSearchParams(location.search).get("name") ?? `player-${Math.floor(Math.random() * 900 + 100)}`;
  const spectate = new URLSearchParams(location.search).get("spectate") === "1";
  link.session = new Session(link.sim, t, spectate ? `${name} (presenter)` : name, spectate);
  return link;
}

/** Measures key press → first frame where your own view moves (P02, P04). Real timestamps only.
 *  A press counts only if the view was standing still on the frame before the press was seen. */
export class MotionProbe {
  private armedAt = -1;
  private from: { x: number; y: number; z: number } | null = null;
  private seenPress = -1;
  private prev: { x: number; y: number; z: number } | null = null;
  private prevStill = false;
  results: number[] = [];
  update(now: number, pressAt: number, pos: { x: number; y: number; z: number }) {
    if (pressAt !== this.seenPress) {
      this.seenPress = pressAt;
      if (this.prevStill && this.prev && this.armedAt < 0 && pressAt > 0) { this.armedAt = pressAt; this.from = { ...this.prev }; }
    }
    if (this.armedAt >= 0 && this.from) {
      if (Math.hypot(pos.x - this.from.x, pos.z - this.from.z) > 0.005) {
        this.results.push(now - this.armedAt);
        if (this.results.length > 10) this.results.shift();
        this.armedAt = -1;
      } else if (now - this.armedAt > 2000) this.armedAt = -1;
    }
    this.prevStill = !!this.prev && Math.hypot(pos.x - this.prev.x, pos.z - this.prev.z) < 1e-4;
    this.prev = { ...pos };
  }
  get median(): number | null {
    if (!this.results.length) return null;
    const s = [...this.results].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }
}

async function boot() {
  const canvas = el("canvas", { id: "view" });
  hud.appendChild(canvas);
  const banner = new Banner(hud);
  const scorecard = new Scorecard(hud);
  const graph = new NetGraph(hud);
  const modeHud = el("div", { id: "modehud", class: "hud box" });
  modeHud.style.display = "none";
  hud.appendChild(modeHud);
  hud.appendChild(el("div", { id: "crosshair", class: "hud" }));

  const start = el("div", { id: "start" });
  const card = el("div", { class: "card box" }, "<h1>Netcode Lab</h1><p class='dim'>Connecting…</p>");
  start.appendChild(card);
  hud.appendChild(start);

  const [link, assets] = await Promise.all([connect(), loadAssets()]);
  const s = link.session;
  const lab = new LabPanel(hud, s ?? offlineBackend);
  if (s) s.onChange = () => lab.refresh();

  const row = (ok: boolean, name: string, note: string) => `<div class="row"><span class="${ok ? "ok" : "bad"}">${ok ? "✓" : "✗"}</span> ${name} <span class="dim">${note}</span></div>`;
  const keyRow = (icons: string[], text: string) => `<div class="ctl">${icons.map((i) => `<img src="./ui/keys/${i}.svg" alt="" width="28" height="28">`).join("")}<span>${text}</span></div>`;
  const controls = `<div class="controls">
    ${keyRow(["w", "a", "s", "d"], "move")}${keyRow(["space"], "jump")}
    ${keyRow(["mouse_move"], "look")}${keyRow(["mouse_left"], "fire")}
    ${keyRow(["tab"], "scoreboard")}${keyRow(["f1"], "Lab panel")}
    ${keyRow(["f2"], "presenter view")}${keyRow(["esc"], "release mouse")}
  </div>`;
  card.innerHTML = `<h1><img class="logo" src="./ui/logo.svg" alt="Netcode Lab" width="280" height="64"></h1>
    ${row(courtyard !== null, "Courtyard map", courtyard ? "shared/map.json" : "shared/map.json missing")}
    ${row(link.sim !== null, "Shared sim (WASM)", link.sim ? `api v${link.sim.apiVersion}` : "")}
    ${row(s !== null, "Game server", s ? `connected over ${s.t.kind === "wt" ? "WebTransport" : "WebSocket"}` : "")}
    ${link.problems.map((p) => `<div class="bad">${p}</div>`).join("")}
    ${assets.failures.length ? `<div class="bad">Assets using primitive fallback: ${assets.failures.join("; ")}</div>` : ""}
    ${controls}
    <p class="dim">${s && new URLSearchParams(location.search).get("spectate") === "1" ? "Presenter: you join without a player. F2 toggles the top-down view; outside it, drag to look and WASD to fly." : s ? "Click Play to join your team." : "Offline: spectator camera only (WASD fly, Space up, Shift down); not the game's movement rules."}</p>`;
  const go = el("button", {}, s ? "Play" : "Enter spectator view");
  (go as HTMLButtonElement).disabled = !courtyard;
  card.appendChild(go);
  if (!courtyard) return;

  const world = new World(canvas, courtyard, assets);
  const presenter = new PresenterView(hud, courtyard);
  let presenterAuto = false;
  const sfx = new Sfx();
  const vfx = new ShotVfx(world.scene, world.camera, assets.vfx.impact_decal ?? null, () => world.shotTargets());
  let lastShotAt = -Infinity;
  const combat = new CombatHud(hud, { hit: "./textures/vfx/hit_marker.png", head: null, skull: null } /* headshot.png and kill_icon.png at bfce3d7 are not usable images (reported) */);
  let deathRespawnTick: number | null = null;
  const overlay = link.sim ? new HitboxOverlay(world.scene, { body: link.sim.PLAYER.body, head: link.sim.PLAYER.head }) : null;
  const replay = new DeathReplay(hud, courtyard);
  const glitchBox = el("div", { id: "glitchbox", class: "hud box" });
  glitchBox.style.display = "none";
  hud.appendChild(glitchBox);
  const shotReason = el("div", { id: "shotreason", class: "hud box" });
  shotReason.style.display = "none";
  hud.appendChild(shotReason);
  let shotReasonUntil = 0;
  /** What this client drew for each other player when it fired (P08/P09 red box), by input seq. */
  const shotSeen = new Map<number, { at: number; seen: Map<number, Vec3> }>();
  const ownTrail: { t: number; p: Vec3 }[] = [];
  let killerName = "";
  let lastPhase: string | null = null;
  if (s) {
    const nameOf = (id: number) => id === s.id ? `${s.name} (you)` : s.players.get(id)?.name ?? `player ${id}`;
    const teamOf = (id: number) => id === s.id ? s.team : s.players.get(id)?.team ?? "";
    s.onSnapEvent = (e, now) => {
      switch (e.type) {
        case "shot":
          if (e.hitId) { combat.hit(e.damage, e.hitbox === HIT_HEAD, now); sfx.play(e.hitbox === HIT_HEAD ? "headshot" : "hit_marker"); }
          if (e.killed) { combat.killConfirmed(nameOf(e.hitId), e.hitbox === HIT_HEAD, now); sfx.play("kill_confirm"); }
          onShotResult(e, now);
          break;
        case "damage":
          combat.damaged(e.damage, nameOf(e.shooterId), now);
          break;
        case "death":
          killerName = nameOf(e.shooterId);
          deathRespawnTick = e.respawnTick;
          sfx.play("player_death");
          showDeathReplay(e);
          break;
      }
    };
    s.onKill = (m, now) => combat.feedKill(m, teamOf, s.id, now);
    s.onClaimRejected = (m, now) => {
      if (m.victimId === 0) return; // position-only claims still in flight when trust mode ends: not a hit claim

      combat.feedNote(`<span class="trust">rejected claim</span> from ${m.name}: "hit ${nameOf(m.victimId)}${m.hitbox === HIT_HEAD ? " in the head" : ""}" — ${m.reason}`, now);
      sfx.play("rejected_claim");
    };
  }
  /** Predicted cosmetics (B.3): flash, tracer, decal and sound play at once; hit feedback waits for the server. */
  let lastShotTick = -Infinity;
  /** Cosmetic shots follow the server's fire acceptance: one per fireCooldownTicks inputs (600 rpm). Offline: 100 ms. */
  const fireCosmetic = (now: number, clientTick?: number) => {
    if (clientTick !== undefined && s) {
      const cd = s.sim.fireCooldownTicks(s.tickRate);
      if (clientTick - lastShotTick < cd) return false;
      lastShotTick = clientTick;
    } else if (now - lastShotAt < FIRE_INTERVAL_MS) return false;
    lastShotAt = now;
    world.rifle.fire(now);
    vfx.fire(now, world.rifle.muzzleWorld());
    sfx.play("rifle_shot", 0.6);
    return true;
  };
  const input = new InputCapture(canvas);
  const fps = new FpsMeter();
  const probe = new MotionProbe();
  let lastFrameMs = 0;
  let frameAvg = 1000 / 60;
  let presenterSimNote = "";
  const cam = { x: 0, y: 6, z: 30 };
  input.pitch = -0.2;
  if (s) {
    s.onSpawn = (yaw, pitch) => { input.yaw = yaw; input.pitch = pitch; };
    const sp = s.ownServer ?? (s.predictorInfo()?.state ?? null);
    if (sp && link.sim) { input.yaw = link.sim.angleToRadians(sp.yaw); input.pitch = link.sim.angleToRadians(sp.pitch); }
  }
  const dims: PlayerDims | null = link.sim
    ? { width: link.sim.PLAYER.halfWidth * 2, height: link.sim.PLAYER.height, headSize: link.sim.PLAYER.head.half * 2, headBottom: link.sim.PLAYER.head.bottom, eyeHeight: link.sim.PLAYER.eyeHeight }
    : null;

  go.addEventListener("click", () => { sfx.unlock(); input.lock(); });
  canvas.addEventListener("click", () => { if (!input.active && !lab.open && !presenter.open) { sfx.unlock(); input.lock(); } });
  const dragNote = el("div", { id: "dragnote", class: "hud box" }, "no pointer lock: drag to look · left click fires · Esc for menu");
  dragNote.style.display = "none";
  hud.appendChild(dragNote);
  input.onLockError = (msg) => {
    let el2 = card.querySelector<HTMLElement>(".lockerr");
    if (!el2) { el2 = el("div", { class: "bad lockerr" }); card.appendChild(el2); }
    el2.textContent = msg;
  };
  input.onActiveChange = (active) => {
    // A lock (or drag mode) that lands after the Lab or presenter opened would capture every click meant for the panel.
    if (active && (lab.open || presenter.open)) { input.deactivate(); return; }
    start.style.display = active || lab.open || presenter.open ? "none" : "flex";
    dragNote.style.display = input.dragMode ? "" : "none";
  };
  if (!s) input.onFirePress = () => fireCosmetic(performance.now());
  if (s) {
    presenter.onPause = () => s.requestHistory();
    s.onHistory = (h) => {
      const F = s.sim.FX;
      presenter.setHistory(h.ticks.map((t) => ({ tick: t.tick, serverTimeMs: t.serverTimeMs, players: t.players.filter((p) => p.alive).map((p) => ({ id: p.id, team: p.team === "orange" ? 1 : 0, x: p.x / F, z: p.z / F })) })));
    };
    s.debugSource = () => {
      const now = performance.now();
      const v = s.ownView(now, frameAvg);
      if (!v) return null;
      const est = s.clockEstimate(now);
      return { tick: Math.floor(est.serverTick), serverMs: est.serverTimeMs, own: v, others: [...lastDrawn].map(([id, e]) => ({ id, x: e.x, y: (e as any).y ?? 0, z: e.z })) };
    };
    s.reportSource = () => ({ fps: fps.fps });
  }
  presenter.onToggle = (open) => {
    if (open) input.deactivate();
    start.style.display = open || lab.open || input.active ? "none" : "flex";
  };
  lab.onToggle = (open) => {
    if (open) input.deactivate();
    start.style.display = open || presenter.open || input.active ? "none" : "flex";
  };
  const keys = new Set<string>();
  addEventListener("keydown", (e) => { if (input.active) keys.add(e.code); });
  addEventListener("keyup", (e) => keys.delete(e.code));

  const loop = new FixedLoop(64, {
    onTick() {
      if (s && !s.spectator) return; // playing: ticks come from the WASM pacer, see onRender
      const i = input.sample();
      const step = 12 / 64;
      const fx = -Math.sin(i.yaw), fz = -Math.cos(i.yaw);
      const mx = (i.forward ? 1 : 0) - (i.back ? 1 : 0), sx = (i.right ? 1 : 0) - (i.left ? 1 : 0);
      cam.x += (fx * mx - fz * sx) * step;
      cam.z += (fz * mx + fx * sx) * step;
      cam.y += ((i.jump ? 1 : 0) - (keys.has("ShiftLeft") ? 1 : 0)) * step;
    },
    onRender(_alpha, frameMs) {
      const now = performance.now();
      fps.push(now);
      lastFrameMs = frameMs;
      if (s && s.connected) {
        s.frame(now, () => input.sample(), (seq, clientTick) => {
          if (s.dead || !fireCosmetic(now, clientTick)) return null;
          onShot(seq, now);
          return s.setting<string>("authority", "server") === "trust" ? trustHit() : null;
        });
        frameAvg = frameMs > 0 ? frameAvg * 0.9 + Math.min(frameMs, 100) * 0.1 : frameAvg;
        const v = s.ownView(now, frameAvg);
        if (v) { ownTrail.push({ t: now, p: { ...v } }); while (ownTrail.length && now - ownTrail[0].t > 2000) ownTrail.shift(); }
        if (v && dims) {
          probe.update(now, input.lastMoveKeyAt, v);
          world.setView(v.x, v.y + dims.eyeHeight, v.z, input.yaw, input.pitch);
        }
        if (s.spectator) world.setView(cam.x, cam.y, cam.z, input.yaw, input.pitch);
        drawOthers(now);
        recordPresenter(now, v);
      } else {
        world.setView(cam.x, cam.y, cam.z, input.yaw, input.pitch);
      }
      world.rifle.update(now, frameMs);
      vfx.update(now);
      combat.update(now);
      overlay?.update(now);
      if (now > shotReasonUntil) shotReason.style.display = "none";
      world.animate(frameMs);
      world.render();
    },
  });

  /** Records what this client drew for every other player at the moment it fired (P08 reason, P09 red box). */
  function onShot(seq: number, now: number) {
    const seen = new Map<number, Vec3>();
    for (const [id, e] of lastDrawn) seen.set(id, { x: e.x, y: (e as any).y ?? 0, z: e.z });
    shotSeen.set(seq, { at: now, seen });
    for (const [k, v] of shotSeen) if (now - v.at > 3000) shotSeen.delete(k);
  }

  /** A.5 trust mode only: this client decides its own hit — ray from its predicted eye against the players as drawn,
   *  stopped by the first map box (sim traceMap). The server relays the verdict without checks. */
  function trustHit(): { victimId: number; hitbox: number } | null {
    if (!s || !link.sim) return null;
    const S = s.sim, st = s.predictorInfo()?.state;
    if (!st) return null;
    const yaw = S.angleFromRadians(input.yaw), pitch = S.angleFromRadians(input.pitch);
    const wall = S.traceMap(st.x, st.y, st.z, yaw, pitch);
    const d = S.aimDir(yaw, pitch);
    const o = new THREE.Vector3(st.x / S.FX, st.y / S.FX + S.PLAYER.eyeHeight, st.z / S.FX);
    const ray = new THREE.Ray(o, new THREE.Vector3(d[0], d[1], d[2]));
    let best: { victimId: number; hitbox: number; dist: number } | null = null;
    const P = S.PLAYER, hit = new THREE.Vector3();
    for (const [id, e] of lastDrawn) {
      const team = (e as any).team === 1 ? "orange" : "blue";
      if (team === s.team || (e as any).alive === false) continue;
      const y = (e as any).y ?? 0;
      for (const [hb, half, y0, y1] of [[HIT_HEAD, P.head.half, P.head.bottom, P.head.top], [1, P.body.half, 0, P.body.top]] as const) {
        const box = new THREE.Box3(new THREE.Vector3(e.x - half, y + y0, e.z - half), new THREE.Vector3(e.x + half, y + y1, e.z + half));
        if (!ray.intersectBox(box, hit)) continue;
        const dist = hit.distanceTo(o);
        if (dist < wall && (!best || dist < best.dist)) best = { victimId: id, hitbox: hb, dist };
      }
    }
    return best ? { victimId: best.victimId, hitbox: best.hitbox } : null;
  }

  function onShotResult(e: ShotEvent, now: number) {
    if (!s) return;
    const F = s.sim.FX;
    const target = e.hitId || e.seenId;
    const red = e.seenId || e.hitId ? toVec(e.seenPos, F) : null; // server: target at your render time (what you saw)
    const blue = e.seenId || e.hitId ? toVec(e.usedPos, F) : null; // server: target at the time it checked
    if (overlay && red && blue) overlay.show(now, red, blue);
    const drawnAtFire = target ? shotSeen.get(e.shotSeq)?.seen.get(target) ?? null : null;
    const name = (id: number) => s.players.get(id)?.name ?? `player ${id}`;
    const checked = e.lagcomp ? `rewound to tick ${(e.rewoundTick + e.rewoundFrac / 65536).toFixed(2)}` : e.favoured ? "did not rewind (favour victim: your RTT is above the limit)" : "checked current positions (lag compensation off)";
    let text: string;
    if (e.hitId) text = `Hit ${name(e.hitId)}${e.hitbox === HIT_HEAD ? " in the head" : ""} — the server ${checked}${e.trust ? " (trust mode: your own claim)" : ""}.`;
    else if (e.seenId) text = `Miss on the server: you aimed on ${name(e.seenId)}, but the server ${checked}. Server history: they moved ${e.movedCm} cm between your render time and the time it checked.`;
    else text = `Miss: your ray hit no player at your render time either${e.clamped ? ` (rewind clamped by the ${s.setting("historyMs", 0)} ms history cap)` : ""}.`;
    const drawnNote = drawnAtFire && blue
      ? ` <span class="dim">This client drew them ${(Math.hypot(drawnAtFire.x - blue.x, drawnAtFire.z - blue.z) * 100).toFixed(0)} cm from where the server checked (client drawing vs server).</span>` : "";
    shotReason.innerHTML = `${text}${drawnNote}${red ? ' <span class="dim">· <span style="color:#ef4444">red</span> = at your render time · <span style="color:#3b82f6">blue</span> = where the server checked</span>' : ""}`;
    shotReason.style.display = "";
    shotReasonUntil = now + 3500;
  }

  function showDeathReplay(e: DeathEvent) {
    if (!s || !link.sim) return;
    const F = s.sim.FX;
    const st = s.ownByTick.get(e.resolveTick);
    const youAtHit = st ? { x: st.x / F, y: st.y / F, z: st.z / F } : null;
    const shooter = toVec(e.shooterPos, F);
    let cover: boolean | null = null;
    if (youAtHit) {
      const from = new THREE.Vector3(shooter.x, shooter.y + link.sim.PLAYER.eyeHeight, shooter.z);
      const to = new THREE.Vector3(youAtHit.x, youAtHit.y + link.sim.PLAYER.eyeHeight, youAtHit.z);
      const dir = to.clone().sub(from);
      const rc = new THREE.Raycaster(from, dir.clone().normalize(), 0, dir.length());
      cover = rc.intersectObjects(world.mapMeshes, false).length > 0;
    }
    const now = performance.now();
    replay.show(e, killerName, ownTrail.filter((o) => now - o.t < 1500).map((o) => o.p), youAtHit, toVec(e.hitPos, F), shooter, cover, s.tickMs,
      s.setting("historyMs", 1000), s.setting("favorVictimRttMs", 0));
  }

  function recordPresenter(now: number, v: { x: number; y: number; z: number } | null) {
    if (!s) return;
    const F = s.sim.FX;
    const r = s.renderServerMs(now);
    const est = s.clockEstimate(now);
    const teamOf = (id: number) => id === s.id ? (s.team === "orange" ? 1 : 0) : ((s.interp.latest()?.entities.get(id) as any)?.team ?? 0);
    const drawn: { id: number; team: number; x: number; z: number }[] = [];
    for (const [id, e] of lastDrawn) drawn.push({ id, team: (e as any).team ?? 0, x: e.x, z: e.z });
    const predicted: { id: number; team: number; x: number; z: number }[] = [];
    for (const [id, d] of s.debugFrom) {
      if (now - d.at > 500 || id === s.id) continue;
      predicted.push({ id, team: s.players.get(id)?.team === "orange" ? 1 : 0, x: d.data.own.x, z: d.data.own.z });
    }
    presenter.record({
      t: now,
      predicted,
      simNote: presenterSimNote,
      serverNowMs: est.ready ? est.serverTimeMs : null,
      renderServerMs: r,
      truth: s.ghost && s.setting("truthGhost", false) ? s.ghost.players.map((p) => ({ id: p.id, team: teamOf(p.id), x: p.x / F, z: p.z / F })) : null,
      truthTick: s.ghost?.serverTick ?? null,
      drawn,
      own: v ? { id: s.id, team: s.team === "orange" ? 1 : 0, x: v.x, z: v.z, yaw: input.yaw } : null,
      ownServer: s.ownServer ? { x: s.ownServer.x / F, z: s.ownServer.z / F } : null,
    });
    presenter.draw();
  }
  let lastDrawn = new Map<number, { x: number; z: number }>();

  function drawOthers(now: number) {
    if (!s || !dims) return;
    const alive = new Set<number>();
    const r = s.renderServerMs(now);
    const sample = r === null ? null : s.setting("interp", true) ? s.interp.sample(r) : (() => { const l = s.interp.latest(); return l ? { entities: l.entities, held: true } : null; })();
    if (sample) {
      lastDrawn = sample.entities as Map<number, { x: number; z: number }>;
      for (const [id, e] of sample.entities) {
        alive.add(id);
        const team: Team = (e as any).team === 1 ? "orange" : "blue";
        world.upsertPlayer(id, team, e.x, e.y, e.z, e.yaw, dims, e.alive, !!(e as any).moving);
      }
    }
    if (s.ghost && s.setting("truthGhost", false)) {
      const F = s.sim.FX;
      for (const p of s.ghost.players) if (p.id !== s.id && alive.has(p.id)) world.upsertGhost(p.id, p.x / F, p.y / F, p.z / F, 0, dims);
    } else world.hideGhosts();
    world.removeMissing(alive);
  }

  // Handle for automated browser checks (Playwright cannot grant pointer lock headless).
  (window as any).__netlab = { input, session: s, probe, presenter, vfx, world, shotSeen, drawn: () => lastDrawn, lab };
  // Duel's D3 presenter displays (P11/P12/P15/P19/P29); mounted after the page set its session handlers, which it wraps.
  if (s) (window as any).__perf = mountPerf(s, hud);
  if (s) (window as any).__wire = mountWire(s, hud);
  lab.local = {
    get fpsCap() { return loop.fpsCap; },
    setFpsCap(v: number) { loop.fpsCap = v as FpsCap; },
  };
  loop.start();

  let probeEpoch = -1;
  const f = (v: number | null | undefined, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? null : Number(v.toFixed(d)));
  setInterval(() => {
    const now = performance.now();
    if (!s) {
      graph.render([
        { key: "fps", label: "FPS", value: `${fps.fps} (${lastFrameMs.toFixed(1)} ms)`, source: "measured" },
        { key: "net", label: "network", value: "offline", source: "measured" },
      ]);
      banner.set([`${webTransportPossible() ? "" : '<span class="warn">WebSocket fallback</span> — page is not a secure context. '}Offline: not connected to a game server.`]);
      return;
    }
    const st = s.settings;
    if (st && loop.fpsCap !== st.fpsCap) loop.fpsCap = st.fpsCap as FpsCap;
    const est = s.clockEstimate(now);
    const pi = s.predictorInfo();
    const sv = s.serverStats;
    const m = s.meas;
    const rows: Row[] = [
      { key: "rtt", label: "RTT", value: est.ready ? f(est.rttMs, 1) : null, unit: "ms", source: "measured" },
      { key: "jitter", label: "jitter", value: est.ready ? f(est.jitterMs, 1) : null, unit: "ms", source: "measured" },
      { key: "loss", label: `loss up/down (${m.lossWindowS} s)`, value: m.upLossPct === null && m.downLossPct === null ? null : `${m.upLossPct?.toFixed(1) ?? "—"} / ${m.downLossPct?.toFixed(1) ?? "—"} %`, source: "measured" },
      { key: "tick", label: "server tick", value: s.lastSnapshotTick ? `${s.lastSnapshotTick} @ ${s.tickRate} Hz` : null, source: "server" },
      { key: "snap", label: "snapshots", value: m.snapsPerSec === null ? null : `${m.snapsPerSec.toFixed(1)}/s (set ${st?.sendRate ?? "—"})`, source: "measured" },
      { key: "gap", label: "max snapshot gap", value: m.snapsPerSec === null ? null : f(m.maxSnapGapMs, 0), unit: "ms", source: "measured" },
      { key: "interp", label: "interp buffer", value: st ? (st.interp ? `${s.bufferMs.toFixed(0)} ms${st.interpAuto ? ` (${st.interpK}× interval)` : ""}` : "off (raw)") : null, source: "setting" },
      { key: "pending", label: "pending inputs", value: pi ? pi.pending.length : null, source: "measured" },
      { key: "corr", label: "corrections", value: pi ? pi.corrections - s.correctionsBase : null, source: "measured" },
      { key: "svtick", label: "server tick time", value: sv?.tick ? `p99 ${sv.tick.p99Ms.toFixed(2)} ms · ${sv.tick.withinBudgetPct.toFixed(1)}% ok` : null, source: "server" },
      { key: "inbuf", label: "server input buffer", value: s.ownInfo ? `${s.ownInfo.inputBuffer} (starved ${s.ownInfo.starved})` : null, source: "server" },
      { key: "fps", label: "FPS", value: `${fps.fps} (${lastFrameMs.toFixed(1)} ms)`, source: "measured" },
      { key: "kbps", label: "kbps up/down", value: m.kbpsUp === null ? null : `${m.kbpsUp.toFixed(1)} / ${m.kbpsDown!.toFixed(1)}`, source: "measured" },
    ];

    const mode: ModeState | null = st ? {
      mode: st.authority === "trust" ? "trust" : !st.predict ? "dumb" : "auth",
      predict: !!st.predict, reconcile: !!st.reconcile, interp: !!st.interp,
      lagcomp: !!st.lagcomp && s.isBuilt("lagcomp"),
    } : null;
    scorecard.render(mode, st && !s.isBuilt("lagcomp") ? { fair: "lag compensation not built yet" } : st && st.lagcomp && st.favorVictimRttMs > 0 ? { fair: `lag compensation (none above ${st.favorVictimRttMs} ms RTT)` } : {});

    // P25: name the active glitch on screen (text from the server), with the measured effect next to it.
    const g = s.glitch;
    const rubberOn = typeof st?.speedScale === "number" && st.speedScale < 1;
    const burstLive = g?.kind === "lossBurst" && now - g.at < (g.ms ?? 400) + 2000;
    if (rubberOn || burstLive) {
      const name = rubberOn ? (g?.kind === "rubberband" ? g.name : "Rubber-banding") : g!.name;
      const explain = rubberOn ? (g?.kind === "rubberband" ? g.explain : `server-only speed ×${st!.speedScale}`) : g!.explain;
      const effect = rubberOn ? `corrections since last Lab change: ${pi ? pi.corrections - s.correctionsBase : "—"} (measured)` : `max snapshot gap: ${m.maxSnapGapMs.toFixed(0)} ms (measured, last 1 s)`;
      glitchBox.innerHTML = `<b>Glitch: ${name}</b><br>${explain}<br><span class="dim">${effect}</span>`;
      glitchBox.style.display = "";
    } else glitchBox.style.display = "none";
    const serverNow = est.ready ? est.serverTimeMs : null;
    combat.round(s.round, serverNow);
    if (s.round && s.round.state !== lastPhase) {
      if (lastPhase !== null) sfx.play(s.round.state === "playing" ? "round_start" : "round_end");
      lastPhase = s.round.state;
    }
    if (!s.dead && deathRespawnTick !== null) { deathRespawnTick = null; replay.hide(); }
    combat.respawnIn(s.dead && deathRespawnTick !== null && est.ready ? (deathRespawnTick - est.serverTick) * s.tickMs / 1000 : null, killerName);
    const boardRows: ScoreRow[] = s.scoreRows ?? [
      { id: s.id, name: `${s.name}`, team: s.team, kills: null, deaths: null, pingMs: est.ready ? Math.round(est.rttMs) : null, lossPct: m.downLossPct, fps: fps.fps },
      ...[...s.players].filter(([id]) => id !== s.id).map(([id, p]) => ({ id, name: p.name, team: p.team as "blue" | "orange", kills: null, deaths: null, pingMs: null, lossPct: null, fps: null })),
    ];
    combat.scoreboard(boardRows, s.id, s.scoreRows ? "From the server's 1 Hz scoreboard." : "Waiting for the server's scoreboard; your own row is measured here.");
    if (s.spectator && !presenterAuto) {
      // Presenter join (?spectate=1): no player, no rifle, the top-down view opens by itself.
      presenterAuto = true;
      world.rifle.setVisible(false);
      start.style.display = "none";
      presenter.toggle(true);
    }
    if (s.settingsEpoch !== probeEpoch) { probeEpoch = s.settingsEpoch; probe.results = []; }
    // A.16: the server's conditioner adds simulated delay/jitter/loss to every measured network number.
    const c = s.cond;
    const simRtt = c ? c.up.delayMs + c.down.delayMs : 0;
    const simJit = c ? c.up.jitterMs + c.down.jitterMs : 0;
    const simLoss = c ? c.up.lossPct + c.down.lossPct : 0;
    const tag = (part: string | null): Row["source"] => (part ? `measured, incl. simulated ${part}` : "measured");
    const rttTag = simRtt ? `${simRtt} ms` : null;
    const jitTag = simJit ? `jitter ${c!.up.jitterMs}/${c!.down.jitterMs} ms` : null;
    const lossTag = simLoss ? `loss ${c!.up.lossPct}/${c!.down.lossPct} %` : null;
    const gapTag = simJit || simLoss ? [jitTag, lossTag].filter(Boolean).join(", ") : null;
    for (const r of rows) {
      if (r.key === "rtt") r.source = tag(rttTag);
      if (r.key === "jitter") r.source = tag(jitTag);
      if (r.key === "loss") r.source = tag(lossTag);
      if (r.key === "gap") r.source = tag(gapTag);
    }
    graph.render(rows);
    const simNoteRtt = rttTag ? `, incl. simulated ${rttTag} RTT` : "";
    const simNoteDown = c && c.down.delayMs ? `, incl. simulated ${c.down.delayMs} ms downlink` : "";
    presenterSimNote = simNoteDown;

    const lines: string[] = [];
    if (s.t.kind === "ws") lines.push(`<span class="warn">WebSocket fallback</span> — ${link.transportNote}; game packets go over TCP. Conditioner loss on this path is a retransmit stall that holds later packets (head-of-line blocking, simulated).`);
    if (!s.connected) lines.push(`<span class="warn">Disconnected</span>: ${s.closedReason}. Reload to rejoin.`);
    if (s.activePreset === "custom") lines.push("Custom Lab settings (no preset)");
    else if (s.activePreset) {
      const d = PRESET_DOCS.get(s.activePreset);
      lines.push(d
        ? `<b>${d.id} ${d.idea}</b> — ${d.banner} <a href="${conceptUrl(d.concept)}" target="_blank" rel="noopener">Read ${d.concept.toUpperCase().replace("A", "A.")} →</a>`
        : `<b>${s.activePreset}</b> ${s.banner}`);
    }
    banner.set(lines);

    const hl: string[] = [];
    if (st) {
      const med = probe.median;
      hl.push(`input → motion: ${med === null ? "press W from standing still" : `${med.toFixed(0)} ms`} <span class="dim">(measured${st.predict ? ", prediction on: no network wait" : simNoteRtt}, median of ${probe.results.length})</span>`
        + (st.predict ? "" : ` <span class="dim">· 40–72 ms est. (A.4, no pacer margin)</span>`));
      if (st.predict && pi) {
        const shown = pi.pending.slice(-6).map((n: number) => "#" + n).join(" ");
        hl.push(`pending: ${shown || "none"}${pi.pending.length > 6 ? " …" : ""} · replayed: ${s.lastReplayed} · corrections: ${pi.corrections - s.correctionsBase} <span class="dim">(since last Lab change)</span>${st.reconcile ? "" : " · reconcile OFF (hard snap)"}`);
      } else hl.push("prediction off: you see only the server's state of yourself");
      const r = s.renderServerMs(now);
      hl.push(st.interp ? `others: interpolated ${s.bufferMs.toFixed(0)} ms in the past` : "others: raw latest snapshot (no interpolation)");
      if (st.truthGhost && r !== null && est.ready) hl.push(`truth ghost leads what you see by ${(est.serverTimeMs - r).toFixed(0)} ms <span class="dim">(measured: synced server clock − render time${simNoteDown})</span>`);
    }
    modeHud.innerHTML = hl.join("<br>");
    modeHud.style.display = hl.length ? "" : "none";
  }, 200);
}

boot();
