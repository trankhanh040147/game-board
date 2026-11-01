/**
 * UI LAB — dev-only harness for the BLADE & MOUNT interface.
 *
 * Renders every screen with plausible sample data over a lightweight arena
 * backdrop so typography, contrast and spacing can be iterated with the
 * headless screenshot tool:
 *
 *   /ui-lab.html?screen=menu | hud | hud-melee | bracket | bracket-grand
 *               | bracket-final | intro | intro-final | result | result-defeat
 *               | end | end-defeat | melee-result | pause | settings | controls
 *               | credits | loading
 *
 * Also exposes `window.__lab.show(screen)` and `window.__lab.audioTest()`.
 */

import '../style.css';
import * as THREE from 'three';
import type {
  HudState, MeleeResultView, Profile, RoundIntroView, RoundResultView, Settings, SfxName,
  TournamentEndView, TournamentMember, TournamentTeam, TournamentView,
} from '../core/types';
import {
  ARENA_NAME, EPITHETS, FIRST_NAMES, TEAM_PALETTE, TOURNAMENT, playerLoadoutForRound,
} from '../core/config';
import { mulberry32 } from '../core/utils';
import { GameUI } from '../ui/ui';
import { audio } from '../audio/audio';

/* ------------------------------------------------------------------ */
/* Sample state                                                        */
/* ------------------------------------------------------------------ */

const params = new URLSearchParams(location.search);
const language: Settings['language'] = params.get('lang') === 'vi' ? 'vi' : 'en';

const settings: Settings = {
  quality: 'high',
  sensitivity: 1,
  invertY: false,
  masterVolume: 0.85,
  musicVolume: 0.5,
  sfxVolume: 0.85,
  cameraShake: 1,
  showHints: true,
  language,
  fov: 62,
};

const profile: Profile = {
  version: 1,
  name: 'Aldric the Bold',
  denars: 1240,
  xp: 2460,
  level: 5,
  renown: 18,
  tournamentsWon: 2,
  tournamentsPlayed: 7,
  meleeRuns: 9,
  bestMelee: 27,
  totalKills: 63,
  createdAt: Date.now(),
  lastPlayed: Date.now(),
};

interface RosterEntry {
  name: string;
  kills: number;
  alive: boolean;
}

const roster: RosterEntry[] = Array.from({ length: 16 }, (_, i) => ({
  name: i === 0
    ? profile.name
    : `${FIRST_NAMES[(i * 7 + 3) % FIRST_NAMES.length]} ${EPITHETS[(i * 11 + 5) % EPITHETS.length]}`,
  kills: [3, 1, 2, 0, 1, 2, 0, 1, 1, 0, 2, 1, 0, 1, 0, 0][i],
  alive: true,
}));

function member(index: number, aliveOverride?: boolean): TournamentMember {
  const entry = roster[index % roster.length];
  return {
    id: index,
    name: entry.name,
    isPlayer: index === 0,
    alive: aliveOverride ?? entry.alive,
    kills: entry.kills,
    hp: 62 + ((index * 13) % 38),
    maxHp: 100,
  };
}

function buildTeams(layout: number[][], seed: number): TournamentTeam[] {
  return layout.map((seats, teamIndex) => {
    const palette = TEAM_PALETTE[teamIndex % TEAM_PALETTE.length];
    const members = seats.map((seat) => member(seat));
    return {
      id: teamIndex,
      name: palette.name.replace('House ', ''),
      color: palette.css,
      colorName: palette.colorName,
      members,
      alive: members.filter((m) => m.alive).length,
      isPlayerTeam: seats.includes(0),
    };
  });
}

const ROUND_TWO_LAYOUT = [[0, 2, 4, 6], [1, 3, 5, 7]];
const ROUND_ONE_LAYOUT = [[0, 5, 10, 15], [1, 4, 11, 14], [2, 7, 8, 13], [3, 6, 9, 12]];
const FINAL_LAYOUT = [[0], [1]];
const roundTwoTeams = (seed = 21): TournamentTeam[] => buildTeams(ROUND_TWO_LAYOUT, seed);
const roundOneTeams = (): TournamentTeam[] => buildTeams(ROUND_ONE_LAYOUT, 11);

function liveTeams(): TournamentTeam[] {
  const teams = roundOneTeams();
  // The grand melee is half fought: some seats are already empty.
  const deathMap = [
    [false, false, false, false],
    [true, true, false, true],
    [false, true, false, false],
    [false, false, false, true],
  ];
  teams.forEach((team, teamIndex) => {
    team.members.forEach((m, seat) => {
      m.alive = !deathMap[teamIndex]?.[seat];
      m.hp = m.alive ? 34 + ((seat * 17 + teamIndex * 9) % 60) : 0;
      if (!m.alive) m.kills = Math.max(0, m.kills - 1);
    });
    team.alive = team.members.filter((m) => m.alive).length;
  });
  return teams;
}

function allMembers(teams: TournamentTeam[]): TournamentMember[] {
  return teams.flatMap((team) => team.members);
}

function tournamentHud(): HudState {
  const teams = liveTeams();
  return {
    mode: 'tournament',
    opponentsBeaten: 0,
    opponentsRemaining: 0,
    opponentsTotal: 0,
    health: 78,
    maxHealth: 110,
    stamina: 64,
    maxStamina: 100,
    roundLabel: 'Round I — The Grand Melee',
    roundIndex: 0,
    roundTotal: 4,
    objective: 'Be among the last two houses standing.',
    teams,
    playerAlive: true,
    target: {
      name: 'Veteran Gladiator',
      hp: 62,
      maxHp: 100,
      distance: 6.4,
      screenX: 836,
      screenY: 336,
      visible: true,
      teamColor: '#4f78bb',
      isLocked: true,
      isPlayerTeam: false,
    },
    hint: 'Hold RMB and drag to choose a guard direction',
    denars: 1180,
    bet: 50,
    paused: false,
  };
}

function meleeHud(): HudState {
  return {
    mode: 'melee',
    opponentsBeaten: 12,
    opponentsRemaining: 23,
    opponentsTotal: 35,
    health: 54,
    maxHealth: 100,
    stamina: 38,
    maxStamina: 100,
    roundLabel: 'Arena Melee',
    roundIndex: 0,
    roundTotal: 1,
    objective: 'Survive the sand. Thirty-five names entered; yours is not yet spent.',
    teams: [],
    playerAlive: true,
    target: null,
    hint: 'Space to dodge · F to kick · Q to lock',
    denars: 1240,
    bet: 0,
    paused: false,
  };
}

function bracketView(kind: 'round' | 'grand' | 'final' = 'round'): TournamentView {
  const isFinal = kind === 'final';
  const isGrand = kind === 'grand';
  const round = isGrand ? 1 : isFinal ? 4 : 2;
  const def = TOURNAMENT.rounds[round - 1];
  const teams = isGrand ? roundOneTeams() : isFinal ? buildTeams(FINAL_LAYOUT, 5) : roundTwoTeams();
  const survivors = isGrand ? [] : isFinal ? [member(0), member(1)] : [member(0), member(2), member(4), member(6),
    member(1), member(3), member(5), member(7)];
  return {
    round,
    totalRounds: TOURNAMENT.rounds.length,
    roundName: def.name,
    roundObjective: def.objective,
    mode: 'tournament',
    purse: def.purse,
    denars: profile.denars,
    bet: isGrand ? 0 : 50,
    maxBet: TOURNAMENT.maxBet,
    canBet: true,
    playerTeam: 0,
    teams,
    survivors,
    playerLoadout: playerLoadoutForRound(round - 1, TEAM_PALETTE[0].color, TEAM_PALETTE[0].secondary, mulberry32(round + 3)),
    arenaName: ARENA_NAME,
    isFinal,
  };
}

function introView(kind: 'round' | 'final' = 'round'): RoundIntroView {
  const isFinal = kind === 'final';
  const round = isFinal ? 4 : 2;
  const def = TOURNAMENT.rounds[round - 1];
  const teams = isFinal ? buildTeams(FINAL_LAYOUT, 5) : roundTwoTeams();
  if (isFinal) {
    teams[1].members[0].kills = 4;
    teams[1].members[0].hp = 91;
    teams[1].name = 'Champion of the Lists';
    teams[1].colorName = 'Gold';
  }
  return {
    round,
    totalRounds: TOURNAMENT.rounds.length,
    roundName: def.name,
    objective: def.objective,
    teams,
    mode: 'tournament',
    loadout: playerLoadoutForRound(round - 1, TEAM_PALETTE[0].color, TEAM_PALETTE[0].secondary, mulberry32(round + 9)),
    isFinal,
  };
}

function introGrandView(): RoundIntroView {
  const def = TOURNAMENT.rounds[0];
  return {
    round: 1,
    totalRounds: TOURNAMENT.rounds.length,
    roundName: def.name,
    objective: def.objective,
    teams: roundOneTeams(),
    mode: 'tournament',
    loadout: playerLoadoutForRound(0, TEAM_PALETTE[0].color, TEAM_PALETTE[0].secondary, mulberry32(12)),
    isFinal: false,
  };
}

const SAMPLE_STATS = {
  kills: 4,
  assists: 2,
  damageDealt: 312,
  damageTaken: 178,
  blocks: 11,
  headshots: 1,
  time: 184,
};

function roundResultView(outcome: 'victory' | 'defeat'): RoundResultView {
  const victory = outcome === 'victory';
  return {
    victory,
    advanced: victory,
    playerSurvived: victory,
    playerTeamWon: victory,
    eliminated: !victory,
    champion: false,
    round: 2,
    totalRounds: TOURNAMENT.rounds.length,
    roundName: victory ? "The Knights' Pass" : 'The Grand Melee',
    stats: victory ? SAMPLE_STATS : { ...SAMPLE_STATS, kills: 1, damageDealt: 96, damageTaken: 210, blocks: 4 },
    rewardDenars: victory ? 120 : 40,
    rewardXp: victory ? 72 : 24,
    rewardRenown: victory ? 2 : 0,
    bet: 50,
    betWon: victory ? 100 : 0,
    purse: victory ? 240 : 60,
    standings: victory ? allMembers(roundOneTeams()) : allMembers(liveTeams()),
    nextRoundName: victory ? "The Duellists' Round" : null,
    playerLevel: profile.level,
    playerXp: profile.xp,
    playerDenars: profile.denars,
    playerRenown: profile.renown,
  };
}

function tournamentEndView(champion: boolean): TournamentEndView {
  return {
    champion,
    eliminated: !champion,
    round: champion ? 4 : 2,
    totalRounds: TOURNAMENT.rounds.length,
    stats: champion ? { ...SAMPLE_STATS, kills: 11, damageDealt: 1180, blocks: 26, time: 612 } : SAMPLE_STATS,
    rewardDenars: champion ? 500 : 60,
    rewardXp: champion ? 260 : 40,
    rewardRenown: champion ? 6 : 0,
    purse: champion ? 940 : 60,
    bet: 50,
    betWon: champion ? 100 : 0,
    standings: allMembers(roundOneTeams()),
    playerLevel: profile.level,
    playerXp: profile.xp,
    playerDenars: profile.denars,
    playerRenown: profile.renown,
    tournamentsWon: profile.tournamentsWon,
    playerName: profile.name,
  };
}

function meleeResultView(): MeleeResultView {
  return {
    victory: false,
    beaten: 17,
    total: 35,
    stats: { ...SAMPLE_STATS, kills: 17, damageDealt: 940, damageTaken: 312, blocks: 19, time: 247 },
    rewardDenars: 25,
    rewardXp: 10,
    rewardRenown: 0,
    best: true,
    playerLevel: profile.level,
    playerXp: profile.xp,
    playerDenars: profile.denars,
    playerRenown: profile.renown,
  };
}

const TOURNAMENT_LOGS: { text: string; kind: 'damage' | 'block' | 'kill' | 'xp' | 'info' | 'warning' | 'reward' }[] = [
  { text: 'The gates open. Fight well, stranger.', kind: 'info' },
  { text: 'Shield block: 12 damage absorbed', kind: 'block' },
  { text: 'Speed bonus: +14%', kind: 'damage' },
  { text: 'Delivered 27 damage to Arena Fighter', kind: 'damage' },
  { text: 'Regular Fighter knocked unconscious', kind: 'kill' },
  { text: 'You got 8 experience', kind: 'xp' },
  { text: 'Wager of 50 denars placed on your house', kind: 'reward' },
  { text: 'Guard broken — shield arm numb', kind: 'warning' },
];

const MELEE_LOGS: { text: string; kind: 'damage' | 'block' | 'kill' | 'xp' | 'info' | 'warning' | 'reward' }[] = [
  { text: 'You enter the arena. Thirty-five await.', kind: 'info' },
  { text: 'Delivered 31 damage to Arena Bruiser', kind: 'damage' },
  { text: 'Arena Fighter knocked unconscious', kind: 'kill' },
  { text: 'You got 8 experience', kind: 'xp' },
  { text: 'Speed bonus: +11%', kind: 'damage' },
  { text: 'Veteran Gladiator struck you for 18', kind: 'warning' },
  { text: 'Eleven names remain on the sand', kind: 'info' },
];

/* ------------------------------------------------------------------ */
/* Arena backdrop                                                      */
/* ------------------------------------------------------------------ */

function canvasTexture(
  size: number,
  paint: (ctx: CanvasRenderingContext2D, s: number) => void,
  repeat = 1,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) paint(ctx, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = 4;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeBackdrop(container: HTMLElement): { dispose(): void; update(dt: number): void } {
  const headless = Boolean((navigator as Navigator & { webdriver?: boolean }).webdriver);
  if (headless) document.documentElement.classList.add('lab-headless');
  const renderer = new THREE.WebGLRenderer({ antialias: !headless, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight, false);
  renderer.shadowMap.enabled = !headless;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.16;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.className = 'game-canvas';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xd9d0bd);
  scene.fog = new THREE.Fog(0xd9d0bd, 46, 132);

  const camera = new THREE.PerspectiveCamera(56, (container.clientWidth || 1280) / (container.clientHeight || 720), 0.1, 320);

  // Sky dome gradient ---------------------------------------------------
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: new THREE.Color('#a9bdc7') },
      uBottom: { value: new THREE.Color('#f2e8d4') },
    },
    vertexShader: /* glsl */ `
      varying vec3 vPos;
      void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop;
      uniform vec3 uBottom;
      varying vec3 vPos;
      void main() {
        float h = normalize(vPos).y;
        float t = smoothstep(-0.06, 0.6, h);
        gl_FragColor = vec4(mix(uBottom, uTop, t), 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(170, 32, 18), skyMat);
  scene.add(sky);

  // Light ---------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0xe4ecf2, 0x7a674d, 1.55));
  const sun = new THREE.DirectionalLight(0xffe7bd, 2.85);
  sun.position.set(-20, 27, 16);
  sun.castShadow = !headless;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -36;
  sun.shadow.camera.right = 36;
  sun.shadow.camera.top = 36;
  sun.shadow.camera.bottom = -36;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 90;
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  scene.add(sun.target);
  const fill = new THREE.DirectionalLight(0xffe9cf, 0.35);
  fill.position.set(16, 12, -14);
  scene.add(fill);

  const sandTex = canvasTexture(256, (ctx, s) => {
    ctx.fillStyle = '#c9b388';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 2600; i++) {
      const x = Math.random() * s;
      const y = Math.random() * s;
      const r = Math.random() * 1.3 + 0.3;
      ctx.fillStyle = Math.random() > 0.5 ? 'rgba(150,128,92,.35)' : 'rgba(232,216,182,.4)';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }, 7);

  const stoneTex = canvasTexture(256, (ctx, s) => {
    ctx.fillStyle = '#9a937f';
    ctx.fillRect(0, 0, s, s);
    const rowH = s / 5;
    for (let row = 0; row < 5; row++) {
      const offset = row % 2 === 0 ? 0 : -s / 8;
      for (let col = -1; col < 3; col++) {
        const w = s / 2.2;
        const x = col * w + offset;
        const shade = 138 + Math.random() * 28;
        ctx.fillStyle = `rgba(${shade}, ${shade - 8}, ${shade - 26}, 1)`;
        ctx.fillRect(x + 2, row * rowH + 2, w - 4, rowH - 4);
        ctx.strokeStyle = 'rgba(84,78,66,.55)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, row * rowH + 1, w - 2, rowH - 2);
      }
    }
  }, 6);

  const woodTex = canvasTexture(128, (ctx, s) => {
    ctx.fillStyle = '#5b4632';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 8; i++) {
      const y = (i / 8) * s;
      ctx.fillStyle = `rgba(${60 + i * 6}, ${46 + i * 4}, ${32 + i * 3}, 1)`;
      ctx.fillRect(0, y, s, s / 8 - 2);
      ctx.fillStyle = 'rgba(28,20,14,.55)';
      ctx.fillRect(0, y + s / 8 - 2, s, 2);
    }
  }, 2);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(140, 140),
    new THREE.MeshStandardMaterial({ map: sandTex, color: 0xffffff, roughness: 0.97 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const trampled = new THREE.Mesh(
    new THREE.CircleGeometry(15, 40),
    new THREE.MeshStandardMaterial({ color: 0xbfa87f, roughness: 1, transparent: true, opacity: 0.75 }),
  );
  trampled.rotation.x = -Math.PI / 2;
  trampled.position.y = 0.012;
  trampled.receiveShadow = true;
  scene.add(trampled);

  const stoneMat = new THREE.MeshStandardMaterial({ map: stoneTex, color: 0xffffff, roughness: 0.92 });
  const woodMat = new THREE.MeshStandardMaterial({ map: woodTex, color: 0xffffff, roughness: 0.9 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x5a4534, roughness: 0.95 });

  const walls: [number, number, number, number, number][] = [
    [0, -23, 54, 1.4, 4.6],
    [0, 23, 54, 1.4, 4.2],
    [-27, 0, 1.4, 46, 4.4],
    [27, 0, 1.4, 46, 4.4],
  ];
  for (const [x, z, w, d, h] of walls) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), stoneMat);
    wall.position.set(x, h / 2, z);
    wall.castShadow = true;
    wall.receiveShadow = true;
    scene.add(wall);
  }

  // Crenellations -------------------------------------------------------
  const merlonGeo = new THREE.BoxGeometry(1.5, 0.85, 1.1);
  const merlonPositions: [number, number, number][] = [];
  for (let x = -26; x <= 26; x += 2.6) {
    merlonPositions.push([x, 5.0, -23], [x, 4.6, 23]);
  }
  for (let z = -22; z <= 22; z += 2.6) {
    merlonPositions.push([-27, 4.8, z], [27, 4.8, z]);
  }
  const merlons = new THREE.InstancedMesh(merlonGeo, stoneMat, merlonPositions.length);
  const temp = new THREE.Object3D();
  merlonPositions.forEach(([x, y, z], i) => {
    temp.position.set(x, y, z);
    temp.rotation.set(0, 0, 0);
    temp.updateMatrix();
    merlons.setMatrixAt(i, temp.matrix);
  });
  merlons.castShadow = true;
  merlons.receiveShadow = true;
  scene.add(merlons);

  // Gatehouse -----------------------------------------------------------
  const gate = new THREE.Group();
  gate.position.set(0, 0, -23);
  for (const side of [-1, 1]) {
    const tower = new THREE.Mesh(new THREE.BoxGeometry(3.2, 7.4, 3.6), stoneMat);
    tower.position.set(side * 5.2, 3.7, 0);
    tower.castShadow = true;
    tower.receiveShadow = true;
    gate.add(tower);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.5, 4.2), stoneMat);
    cap.position.set(side * 5.2, 7.4, 0);
    gate.add(cap);
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(7.6, 3.4, 3.2), stoneMat);
  lintel.position.set(0, 5.6, 0);
  lintel.castShadow = true;
  gate.add(lintel);
  const timber = new THREE.Mesh(new THREE.BoxGeometry(11.6, 2.6, 4.4), woodMat);
  timber.position.set(0, 8.6, -0.2);
  timber.castShadow = true;
  gate.add(timber);
  const roofL = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.35, 5.6), roofMat);
  roofL.position.set(-2.75, 10.15, -0.2);
  roofL.rotation.z = 0.42;
  roofL.castShadow = true;
  gate.add(roofL);
  const roofR = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.35, 5.6), roofMat);
  roofR.position.set(2.75, 10.15, -0.2);
  roofR.rotation.z = -0.42;
  roofR.castShadow = true;
  gate.add(roofR);
  scene.add(gate);

  // Spectator stands ----------------------------------------------------
  const tierMat = new THREE.MeshStandardMaterial({ map: woodTex, color: 0xd8c8a8, roughness: 0.95 });
  const spectators: { x: number; y: number; z: number; color: number; phase: number }[] = [];
  const paletteColors = TEAM_PALETTE.map((team) => team.color);
  const neutralColors = [0x8a7a5e, 0x6b5a44, 0x9c8a68, 0x5e5647];

  function addStand(along: 'x' | 'z', direction: number): void {
    for (let tier = 0; tier < 3; tier++) {
      const height = 0.6 + tier * 0.65;
      const offset = direction * (24 - tier * 1.8);
      const depth = 3.4;
      const bench = new THREE.Mesh(
        new THREE.BoxGeometry(along === 'x' ? 40 : depth, 0.4, along === 'x' ? depth : 40),
        tierMat,
      );
      if (along === 'x') bench.position.set(0, height, offset);
      else bench.position.set(offset, height, 0);
      bench.castShadow = true;
      bench.receiveShadow = true;
      scene.add(bench);

      for (let i = 0; i < 16; i++) {
        const pos = -18 + i * 2.35 + (tier % 2) * 0.5;
        const jitter = (Math.random() - 0.5) * 0.5;
        const color = Math.random() < 0.45
          ? paletteColors[Math.floor(Math.random() * paletteColors.length)]
          : neutralColors[Math.floor(Math.random() * neutralColors.length)];
        if (along === 'x') {
          spectators.push({ x: pos + jitter, y: height + 0.62, z: offset + direction * 0.4, color, phase: Math.random() * 6.28 });
        } else {
          spectators.push({ x: offset + direction * 0.4, y: height + 0.62, z: pos + jitter, color, phase: Math.random() * 6.28 });
        }
      }

      // Posts + roof for the top tier.
      if (tier === 2 && along === 'x') {
        const roof = new THREE.Mesh(new THREE.BoxGeometry(42, 0.3, 5.4), roofMat);
        roof.position.set(0, height + 2.9, offset);
        roof.rotation.x = direction * 0.08;
        roof.castShadow = true;
        scene.add(roof);
        for (let p = -18; p <= 18; p += 6) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 2.9, 6), woodMat);
          post.position.set(p, height + 1.45, offset + direction * 2.2);
          post.castShadow = true;
          scene.add(post);
        }
      }
    }
  }
  addStand('x', -1);
  addStand('z', -1);

  const bodyGeo = new THREE.BoxGeometry(0.42, 0.82, 0.34);
  const headGeo = new THREE.SphereGeometry(0.15, 6, 5);
  const bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.9, vertexColors: false });
  const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ color: 0xb99a7c, roughness: 1 }), spectators.length);
  const bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, spectators.length);
  bodies.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(spectators.length * 3), 3);
  const color = new THREE.Color();
  spectators.forEach((spec, i) => {
    temp.position.set(spec.x, spec.y, spec.z);
    temp.rotation.set(0, Math.atan2(-spec.x, -spec.z), 0);
    temp.updateMatrix();
    bodies.setMatrixAt(i, temp.matrix);
    color.setHex(spec.color).multiplyScalar(0.85 + Math.random() * 0.3);
    bodies.setColorAt(i, color);
    temp.position.y = spec.y + 0.56;
    temp.updateMatrix();
    heads.setMatrixAt(i, temp.matrix);
  });
  bodies.castShadow = true;
  scene.add(bodies);
  scene.add(heads);

  // Banners -------------------------------------------------------------
  const bannerMats = TEAM_PALETTE.map((team) => new THREE.MeshStandardMaterial({
    color: team.color, roughness: 0.9, side: THREE.DoubleSide,
  }));
  const bannerCloths: THREE.Mesh[] = [];
  const bannerSpots: [number, number, number, number][] = [
    [-9, 4.1, -22.2, 0], [9, 4.1, -22.2, 1], [-24.5, 3.9, 8, 2], [-24.5, 3.9, -8, 3],
    [24.5, 3.9, 5, 1], [24.5, 3.9, -6, 0],
  ];
  bannerSpots.forEach(([x, y, z, team], index) => {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 2.2, 6), woodMat);
    pole.position.set(x, y, z);
    scene.add(pole);
    const clothGeo = new THREE.PlaneGeometry(0.95, 2.0, 5, 7);
    const cloth = new THREE.Mesh(clothGeo, bannerMats[team % bannerMats.length]);
    cloth.position.set(x + (z < 0 ? 0.52 : 0), y - 0.1, z + (z < 0 ? 0.02 : 0.02));
    cloth.rotation.y = z < 0 ? 0 : Math.PI / 2;
    cloth.rotation.x = 0.03;
    cloth.castShadow = true;
    cloth.userData.phase = index * 0.9;
    cloth.userData.baseX = cloth.position.x;
    bannerCloths.push(cloth);
    scene.add(cloth);
  });

  // Big rock + props -----------------------------------------------------
  const rock = new THREE.Mesh(
    new THREE.DodecahedronGeometry(2.9, 1),
    new THREE.MeshStandardMaterial({ color: 0x8a8172, roughness: 1, flatShading: true }),
  );
  rock.position.set(11.5, 1.0, -12);
  rock.scale.set(0.9, 0.55, 0.72);
  rock.rotation.set(0.2, 0.7, 0.1);
  rock.castShadow = true;
  rock.receiveShadow = true;
  scene.add(rock);

  const barrelMat = new THREE.MeshStandardMaterial({ color: 0x6b4d30, roughness: 0.9 });
  for (const [x, z] of [[-12, -17], [-10.6, -16.4], [15, -16], [16.2, -17.4]]) {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.36, 0.9, 8), barrelMat);
    barrel.position.set(x, 0.45, z);
    barrel.castShadow = true;
    scene.add(barrel);
  }

  // Trees beyond the walls ----------------------------------------------
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4b3a28, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x4f6b3f, roughness: 1, flatShading: true });
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const radius = 36 + Math.random() * 10;
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.4, 3.4, 6), trunkMat);
    trunk.position.y = 1.7;
    tree.add(trunk);
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(2.4, 0), leafMat);
    crown.position.y = 5.1;
    crown.scale.set(1, 0.85, 1);
    tree.add(crown);
    tree.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
    scene.add(tree);
  }

  // Dust motes ----------------------------------------------------------
  const moteCount = headless ? 90 : 260;
  const motePositions = new Float32Array(moteCount * 3);
  for (let i = 0; i < moteCount; i++) {
    motePositions[i * 3] = (Math.random() - 0.5) * 60;
    motePositions[i * 3 + 1] = Math.random() * 9 + 0.4;
    motePositions[i * 3 + 2] = (Math.random() - 0.5) * 50;
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePositions, 3));
  const motes = new THREE.Points(
    moteGeo,
    new THREE.PointsMaterial({ color: 0xf0e2c4, size: 0.07, transparent: true, opacity: 0.4, depthWrite: false }),
  );
  scene.add(motes);

  // Animation -----------------------------------------------------------
  let elapsed = 0;
  let angle = 0.72;
  const look = new THREE.Vector3(0, 3.2, -4.5);

  function update(dt: number): void {
    elapsed += dt;
    angle += dt * 0.03;
    const radius = 22;
    camera.position.set(Math.cos(angle) * radius, 4.7 + Math.sin(elapsed * 0.12) * 0.25, Math.sin(angle) * radius + 3);
    camera.lookAt(look);
    motes.rotation.y += dt * 0.012;
    for (const cloth of bannerCloths) {
      const phase = cloth.userData.phase as number;
      cloth.rotation.z = Math.sin(elapsed * 1.4 + phase) * 0.045;
      cloth.rotation.x = 0.03 + Math.cos(elapsed * 1.1 + phase) * 0.03;
    }
    renderer.render(scene, camera);
  }

  function onResize(): void {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  window.addEventListener('resize', onResize);
  onResize();

  return {
    update,
    dispose: () => {
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
      });
      renderer.domElement.remove();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

const gameRoot = document.getElementById('game-root') as HTMLElement;

/**
 * `?flat=1` skips WebGL entirely (useful when the machine's GPU is busy with
 * other headless captures). Copy-only states still render over a warm scrim.
 */
const flat = params.get('flat') === '1';
let backdrop: { dispose(): void; update(dt: number): void } | null = null;

if (flat) {
  const style = document.createElement('style');
  style.textContent = `
    html.lab-flat #game-root {
      background:
        radial-gradient(ellipse at 38% 44%, rgba(238, 222, 190, 0.9), rgba(176, 148, 108, 0.65) 42%, rgba(58, 46, 32, 0.95) 100%),
        #1b140d;
    }
  `;
  document.documentElement.classList.add('lab-flat');
  document.head.appendChild(style);
} else {
  backdrop = makeBackdrop(gameRoot);
}

let ui: GameUI;
let currentScreen = 'menu';

function rebuild(): GameUI {
  if (ui) ui.dispose();
  ui = new GameUI({
    onStartTournament: () => show('intro'),
    onStartMelee: () => show('hud-melee'),
    onResume: () => show('hud'),
    onRestart: () => show('intro'),
    onQuitToMenu: () => show('menu'),
    onBet: (amount) => {
      audio.unlock();
      audio.play('bet');
      toastBet(amount);
    },
    onEnterRound: () => show('hud'),
    onContinue: () => show('menu'),
    onSettingsChanged: (next) => {
      Object.assign(settings, next);
      audio.setVolumes(next.masterVolume, next.musicVolume, next.sfxVolume);
      ui.updateSettings({ ...settings });
    },
    onLanguageToggle: () => {
      settings.language = settings.language === 'en' ? 'vi' : 'en';
      ui.updateSettings({ ...settings });
    },
    onOpenSettings: () => show('settings'),
    onOpenControls: () => show('controls'),
    onCloseOverlay: () => show(currentScreen === 'pause' ? 'pause' : 'menu'),
  });
  ui.init(profile, settings);
  ui.setProfile(profile);
  return ui;
}

function toastBet(amount: number): void {
  ui.toast(amount > 0 ? `Wager set: ${amount} denars` : 'Wager withdrawn', 'reward');
}

function pushLogs(entries: { text: string; kind: 'damage' | 'block' | 'kill' | 'xp' | 'info' | 'warning' | 'reward' }[]): void {
  for (const entry of entries) ui.pushLog(entry);
}

function show(screen: string): void {
  currentScreen = screen;
  rebuild();
  ui.hideMainMenu();
  switch (screen) {
    case 'menu':
      audio.startMusic('menu');
      ui.showMainMenu(profile);
      break;
    case 'hud': {
      audio.startMusic('tournament');
      // Cache a sample loadout so the HUD wargear badges show real names.
      ui.showRoundIntro(introView('round'));
      ui.hideRoundIntro();
      ui.showHUD('tournament');
      ui.updateHud(tournamentHud());
      pushLogs(TOURNAMENT_LOGS);
      ui.setDamagePulse(0.28);
      break;
    }
    case 'hud-target-edge': {
      ui.showHUD('tournament');
      const base = tournamentHud();
      ui.updateHud({
        ...base,
        target: {
          name: 'Veteran Gladiator of the Long Watch',
          hp: 44,
          maxHp: 100,
          distance: 3.2,
          screenX: 1266,
          screenY: 96,
          visible: true,
          teamColor: '#4f78bb',
          isLocked: true,
          isPlayerTeam: false,
        },
      });
      pushLogs(TOURNAMENT_LOGS);
      break;
    }
    case 'hud-melee': {
      audio.startMusic('melee');
      ui.showHUD('melee');
      ui.updateHud(meleeHud());
      pushLogs(MELEE_LOGS);
      break;
    }
    case 'bracket':
      ui.showBracket(bracketView('round'));
      break;
    case 'bracket-grand':
      ui.showBracket(bracketView('grand'));
      break;
    case 'bracket-final':
      ui.showBracket(bracketView('final'));
      break;
    case 'intro':
      ui.showRoundIntro(introView('round'));
      break;
    case 'intro-grand':
      ui.showRoundIntro(introGrandView());
      break;
    case 'intro-final':
      ui.showRoundIntro(introView('final'));
      break;
    case 'result':
      ui.showRoundResult(roundResultView('victory'));
      break;
    case 'result-defeat':
      ui.showRoundResult(roundResultView('defeat'));
      break;
    case 'end':
      ui.showTournamentEnd(tournamentEndView(true));
      break;
    case 'end-defeat':
      ui.showTournamentEnd(tournamentEndView(false));
      break;
    case 'melee-result':
      ui.showMeleeResult(meleeResultView());
      break;
    case 'pause':
      ui.showRoundIntro(introView('round'));
      ui.hideRoundIntro();
      ui.showHUD('tournament');
      ui.updateHud(tournamentHud());
      ui.showPause();
      break;
    case 'settings':
      ui.showMainMenu(profile);
      ui.showSettings();
      break;
    case 'controls':
      ui.showMainMenu(profile);
      ui.showControls();
      break;
    case 'credits':
      ui.showMainMenu(profile);
      ui.showCredits();
      break;
    case 'loading':
      ui.setLoading(0.42, 'Summoning the crowd…');
      break;
    default:
      ui.showMainMenu(profile);
      break;
  }
}

async function audioTest(): Promise<Record<string, unknown>> {
  audio.unlock();
  audio.setVolumes(settings.masterVolume, settings.musicVolume, settings.sfxVolume);
  const names: SfxName[] = [
    'swing', 'swing-heavy', 'hit-flesh', 'hit-armor', 'hit-shield', 'block-weapon',
    'guard-break', 'kick', 'death', 'footstep', 'dodge', 'spawn', 'gong', 'horn',
    'crowd-cheer', 'ui-click', 'ui-hover', 'bet', 'victory', 'defeat', 'round-start',
    'bet-win', 'bet-lose',
  ];
  const played: string[] = [];
  for (const name of names) {
    audio.play(name);
    played.push(name);
    await new Promise((resolve) => window.setTimeout(resolve, 70));
  }
  audio.gong();
  audio.cheer(0.8);
  audio.startMusic('tournament');
  await new Promise((resolve) => window.setTimeout(resolve, 900));
  const engine = audio as unknown as { getDiagnostics(): Record<string, unknown> };
  return { played, ...engine.getDiagnostics() };
}

function diagnostics(): Record<string, unknown> {
  const engine = audio as unknown as { getDiagnostics(): Record<string, unknown> };
  return engine.getDiagnostics();
}

window.__lab = {
  show,
  audioTest,
  diagnostics,
  get ui() { return ui; },
  audio,
  profile,
  settings,
};
window.__ready = true;

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  backdrop?.update(dt);
  requestAnimationFrame(frame);
}

const initial = params.get('screen') ?? 'menu';
show(initial);
if (backdrop) requestAnimationFrame(frame);

declare global {
  interface Window {
    __lab: {
      show(screen: string): void;
      audioTest(): Promise<Record<string, unknown>>;
      diagnostics(): Record<string, unknown>;
      readonly ui: GameUI;
      audio: unknown;
      profile: Profile;
      settings: Settings;
    };
    __ready?: boolean;
  }
}
