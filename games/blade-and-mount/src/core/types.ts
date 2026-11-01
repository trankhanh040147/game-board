import type * as THREE from 'three';

/** Quality presets used across rendering, world and characters. */
export type Quality = 'low' | 'medium' | 'high';
export type GameMode = 'tournament' | 'melee';

/* ------------------------------------------------------------------ */
/* Combat primitives                                                   */
/* ------------------------------------------------------------------ */

export type AttackDir = 'left' | 'right' | 'overhead' | 'thrust';
export type GuardDir = AttackDir;

export const ATTACK_DIRS: AttackDir[] = ['left', 'right', 'overhead', 'thrust'];

export type FighterState =
  | 'spawn'
  | 'idle'
  | 'move'
  | 'attack'
  | 'block'
  | 'stagger'
  | 'dodge'
  | 'dead'
  | 'victory';

export type WeaponKind =
  | 'sword'
  | 'saber'
  | 'axe'
  | 'mace'
  | 'greatsword'
  | 'spear'
  | 'staff';

export interface WeaponDef {
  id: string;
  name: string;
  kind: WeaponKind;
  /** Base damage before zone/speed/armour modifiers. */
  damage: number;
  /** 1.0 = normal; higher is faster. Scales attack timing. */
  speed: number;
  /** Metres from chest to effective blade tip. */
  reach: number;
  /** kg-ish; affects stamina cost and movement. */
  weight: number;
  /** 0..0.5 fraction of target armour ignored. */
  armorPen: number;
  twoHanded: boolean;
  /** Visual blade length in metres. */
  length: number;
  bladeColor: number;
  hiltColor: number;
  /** Which body zones this weapon favours (used by AI + hit resolution hints). */
  headBias: number;
}

export interface ShieldDef {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Armour value of the shield when blocking. */
  armor: number;
  /** 0..1; larger blocks a wider arc. */
  coverage: number;
  color: number;
  color2: number;
  emblem: 'cross' | 'chevron' | 'lion' | 'star' | 'bars' | 'sun';
}

export interface ArmorDef {
  id: string;
  name: string;
  /** Body armour 0..65. */
  body: number;
  /** Head protection from helmet: 0..35. */
  head: number;
  /** Leg protection: 0..30. */
  legs: number;
  /** Stamina/movement penalty. */
  weight: number;
  tier: 1 | 2 | 3 | 4;
  /** Visual: torso construction. */
  style: 'gambeson' | 'leather' | 'mail' | 'scale' | 'plate';
  color: number;
  trim: number;
}

export interface HelmetDef {
  id: string;
  name: string;
  style: 'none' | 'skullcap' | 'nasal' | 'spangen' | 'great' | 'barbute';
  armor: number;
  color: number;
}

export interface Loadout {
  weapon: WeaponDef;
  shield: ShieldDef | null;
  armor: ArmorDef;
  helmet: HelmetDef;
  /** Heraldic colours for tabard + shield. */
  color1: number;
  color2: number;
  /** Mode/round label, e.g. "Round II — Mail & Blade". */
  title: string;
}

export interface Appearance {
  seed: number;
  skinTone: number;
  hairColor: number;
  /** 0 none, 1 moustache, 2 short beard, 3 full beard. */
  beard: number;
  /** 0.9..1.1 body scale. */
  build: number;
  /** 0..2 — tunic heraldry pattern. */
  heraldry: number;
  cape: boolean;
  bracers: boolean;
  /** Cosmetic hue variation for cloth/armour. */
  tint: number;
}

export interface AIProfile {
  id: string;
  name: string;
  /** 0..1 overall fighting skill. */
  skill: number;
  /** 0..1 how often they press the attack. */
  aggression: number;
  /** 0..1 how often they guard. */
  defense: number;
  /** Base reaction delay in seconds. */
  reaction: number;
  /** Movement speed multiplier. */
  mobility: number;
  /** 0..1 chance to dodge/react to attacks. */
  footwork: number;
  archetype: 'recruit' | 'fighter' | 'veteran' | 'champion' | 'brute' | 'duelist';
  /** Favourite attack directions (weighted). */
  favorite: AttackDir;
}

/* ------------------------------------------------------------------ */
/* Fighters                                                            */
/* ------------------------------------------------------------------ */

export interface FighterInfo {
  id: number;
  name: string;
  team: number; // -1 = free for all
  isPlayer: boolean;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  facing: number;
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  state: FighterState;
  attackDir: AttackDir | null;
  /** Seconds remaining in the current attack windup (0 if not winding up). */
  windupRemaining: number;
  guardDir: GuardDir | null;
  alive: boolean;
  weapon: WeaponDef;
  shield: ShieldDef | null;
  armor: ArmorDef;
  kills: number;
  /** True while the player is locked onto this fighter. */
  targeted: boolean;
}

export interface Intent {
  /** Desired world-space movement direction (normalized or zero). */
  moveX: number;
  moveZ: number;
  sprint: boolean;
  attack?: AttackDir;
  /** Holding a guard direction; null/undefined = not blocking. */
  block?: GuardDir | null;
  dodge?: { x: number; z: number };
  kick?: boolean;
  /** Request lock-on target (player only). */
  lockTargetId?: number | null;
  /** Desired facing yaw for the player (camera yaw); AI uses target facing. */
  faceYaw?: number;
  /** Toggle sprint-jump not used; reserved. */
  taunt?: boolean;
}

export interface HitInfo {
  attackerId: number;
  defenderId: number;
  attackDir: AttackDir;
  damage: number;
  rawDamage: number;
  zone: 'head' | 'torso' | 'legs';
  speedBonus: number;
  blocked: boolean;
  guardBroken: boolean;
  killed: boolean;
  friendlyFire: boolean;
  point: THREE.Vector3;
  /** Normalized direction from attacker to defender. */
  direction: THREE.Vector3;
}

/* ------------------------------------------------------------------ */
/* World                                                               */
/* ------------------------------------------------------------------ */

export interface CircleObstacle {
  x: number;
  z: number;
  r: number;
}

export interface Arena {
  root: THREE.Group;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  obstacles: CircleObstacle[];
  spawns: THREE.Vector3[];
  teamSpawns: { position: THREE.Vector3; yaw: number }[][];
  playerSpawn: { position: THREE.Vector3; yaw: number };
  update(dt: number, time: number): void;
  setExcitement(level01: number): void;
  cheer(strength01?: number): void;
  clampPosition(pos: THREE.Vector3, radius: number): void;
  dispose(): void;
}

/* ------------------------------------------------------------------ */
/* Characters                                                          */
/* ------------------------------------------------------------------ */

export type RigAction =
  | 'stagger'
  | 'hit'
  | 'die'
  | 'victory'
  | 'dodge'
  | 'kick'
  | 'taunt'
  | 'spawn'
  | 'bash';

export interface CharacterRig {
  root: THREE.Group;
  height: number;
  update(dt: number): void;
  setMotion(speed: number, strafe: number, forward: number): void;
  setGuard(dir: GuardDir | null): void;
  playAttack(dir: AttackDir, speedMul: number): void;
  playAction(action: RigAction, opts?: { dir?: THREE.Vector3; variant?: number }): void;
  setLookTarget(v: THREE.Vector3 | null): void;
  getWeaponTip(out: THREE.Vector3): THREE.Vector3;
  getWeaponBase(out: THREE.Vector3): THREE.Vector3;
  getAnchor(kind: 'head' | 'chest' | 'root', out: THREE.Vector3): THREE.Vector3;
  setOpacity(v: number): void;
  setDead(dead: boolean): void;
  dispose(): void;
}

/* ------------------------------------------------------------------ */
/* AI                                                                  */
/* ------------------------------------------------------------------ */

export interface AIContext {
  self: FighterInfo;
  fighters: FighterInfo[];
  arena: Arena;
  time: number;
  dt: number;
  /** Player controller target (usually the player) — AI may prefer them. */
  playerId: number;
}

export interface AIController {
  update(ctx: AIContext): Intent;
  notifyDamaged?(attackerId: number, dir: AttackDir): void;
  dispose?(): void;
}

/* ------------------------------------------------------------------ */
/* Profile / settings                                                  */
/* ------------------------------------------------------------------ */

export interface Profile {
  version: 1;
  name: string;
  denars: number;
  xp: number;
  level: number;
  renown: number;
  tournamentsWon: number;
  tournamentsPlayed: number;
  meleeRuns: number;
  bestMelee: number;
  totalKills: number;
  createdAt: number;
  lastPlayed: number;
}

export interface Settings {
  quality: Quality;
  sensitivity: number;
  invertY: boolean;
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  cameraShake: number;
  showHints: boolean;
  language: 'en' | 'vi';
  fov: number;
}

/* ------------------------------------------------------------------ */
/* UI data contracts                                                   */
/* ------------------------------------------------------------------ */

export type LogKind = 'damage' | 'block' | 'kill' | 'xp' | 'info' | 'warning' | 'reward';

export interface LogEntry {
  id: number;
  text: string;
  kind: LogKind;
}

export interface TargetView {
  name: string;
  hp: number;
  maxHp: number;
  distance: number;
  screenX: number;
  screenY: number;
  visible: boolean;
  teamColor: string;
  isLocked: boolean;
  isPlayerTeam: boolean;
}

export interface HudState {
  mode: GameMode;
  opponentsBeaten: number;
  opponentsRemaining: number;
  opponentsTotal: number;
  health: number;
  maxHealth: number;
  stamina: number;
  maxStamina: number;
  roundLabel: string;
  roundIndex: number;
  roundTotal: number;
  objective: string;
  teams: TournamentTeam[];
  playerAlive: boolean;
  target: TargetView | null;
  hint: string | null;
  denars: number;
  bet: number;
  paused: boolean;
}

export interface TournamentTeam {
  id: number;
  name: string;
  color: string;
  colorName: string;
  members: TournamentMember[];
  alive: number;
  isPlayerTeam: boolean;
}

export interface TournamentMember {
  id: number;
  name: string;
  isPlayer: boolean;
  alive: boolean;
  kills: number;
  hp: number;
  maxHp: number;
}

export interface TournamentView {
  round: number;
  totalRounds: number;
  roundName: string;
  roundObjective: string;
  mode: GameMode;
  purse: number;
  denars: number;
  bet: number;
  maxBet: number;
  canBet: boolean;
  playerTeam: number;
  teams: TournamentTeam[];
  survivors: TournamentMember[];
  playerLoadout: Loadout;
  arenaName: string;
  isFinal: boolean;
}

export interface RoundIntroView {
  round: number;
  totalRounds: number;
  roundName: string;
  objective: string;
  teams: TournamentTeam[];
  mode: GameMode;
  loadout: Loadout;
  isFinal: boolean;
}

export interface MatchStatsView {
  kills: number;
  assists: number;
  damageDealt: number;
  damageTaken: number;
  blocks: number;
  headshots: number;
  time: number;
}

export interface RoundResultView {
  victory: boolean;
  advanced: boolean;
  playerSurvived: boolean;
  playerTeamWon: boolean;
  eliminated: boolean;
  champion: boolean;
  round: number;
  totalRounds: number;
  roundName: string;
  stats: MatchStatsView;
  rewardDenars: number;
  rewardXp: number;
  rewardRenown: number;
  bet: number;
  betWon: number;
  purse: number;
  standings: TournamentMember[];
  nextRoundName: string | null;
  playerLevel: number;
  playerXp: number;
  playerDenars: number;
  playerRenown: number;
}

export interface TournamentEndView {
  champion: boolean;
  eliminated: boolean;
  round: number;
  totalRounds: number;
  stats: MatchStatsView;
  rewardDenars: number;
  rewardXp: number;
  rewardRenown: number;
  purse: number;
  bet: number;
  betWon: number;
  standings: TournamentMember[];
  playerLevel: number;
  playerXp: number;
  playerDenars: number;
  playerRenown: number;
  tournamentsWon: number;
  playerName: string;
}

export interface MeleeResultView {
  victory: boolean;
  beaten: number;
  total: number;
  stats: MatchStatsView;
  rewardDenars: number;
  rewardXp: number;
  rewardRenown: number;
  best: boolean;
  playerLevel: number;
  playerXp: number;
  playerDenars: number;
  playerRenown: number;
}

export interface UIHandlers {
  onStartTournament(): void;
  onStartMelee(): void;
  onResume(): void;
  onRestart(): void;
  onQuitToMenu(): void;
  onBet(amount: number): void;
  onEnterRound(): void;
  onContinue(): void;
  onSettingsChanged(settings: Settings): void;
  onLanguageToggle(): void;
  onOpenSettings(): void;
  onOpenControls(): void;
  onCloseOverlay(): void;
}

export interface GameUIAPI {
  readonly root: HTMLElement;
  init(profile: Profile, settings: Settings): void;
  showMainMenu(profile: Profile): void;
  hideMainMenu(): void;
  showHUD(mode: GameMode): void;
  hideHUD(): void;
  updateHud(hud: HudState): void;
  pushLog(entry: Omit<LogEntry, 'id'>): void;
  clearLog(): void;
  showBracket(view: TournamentView): void;
  hideBracket(): void;
  showRoundIntro(view: RoundIntroView): void;
  hideRoundIntro(): void;
  showRoundResult(view: RoundResultView): void;
  showTournamentEnd(view: TournamentEndView): void;
  showMeleeResult(view: MeleeResultView): void;
  showPause(): void;
  hidePause(): void;
  showSettings(): void;
  hideSettings(): void;
  showControls(): void;
  hideControls(): void;
  toast(text: string, kind?: LogKind): void;
  setDamagePulse(amount01: number): void;
  setTargetOverlay(target: TargetView | null): void;
  fadeToBlack(ms?: number): Promise<void>;
  fadeFromBlack(ms?: number): Promise<void>;
  setLoading(progress: number | null, label?: string): void;
  setProfile(profile: Profile): void;
  updateSettings(settings: Settings): void;
  dispose(): void;
}

/* ------------------------------------------------------------------ */
/* Audio                                                               */
/* ------------------------------------------------------------------ */

export type SfxName =
  | 'swing'
  | 'swing-heavy'
  | 'hit-flesh'
  | 'hit-armor'
  | 'hit-shield'
  | 'block-weapon'
  | 'guard-break'
  | 'kick'
  | 'death'
  | 'footstep'
  | 'dodge'
  | 'spawn'
  | 'gong'
  | 'horn'
  | 'crowd-cheer'
  | 'ui-click'
  | 'ui-hover'
  | 'bet'
  | 'victory'
  | 'defeat'
  | 'round-start'
  | 'bet-win'
  | 'bet-lose';

export type MusicTrack = 'menu' | 'tournament' | 'melee' | 'victory' | 'defeat';

export interface AudioAPI {
  unlock(): void;
  play(name: SfxName, opts?: { pos?: THREE.Vector3; volume?: number; rate?: number }): void;
  update(camera: THREE.Camera, dt: number): void;
  setVolumes(master: number, music: number, sfx: number): void;
  startMusic(track: MusicTrack): void;
  stopMusic(fade?: number): void;
  setCrowd(level: number): void;
  cheer(strength?: number): void;
  gong(): void;
  dispose(): void;
}
