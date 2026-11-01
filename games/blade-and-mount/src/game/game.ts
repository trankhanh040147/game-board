import * as THREE from 'three';
import { Engine } from '../core/engine';
import { Input } from '../core/input';
import {
  ARENA_NAME,
  ARMORS,
  COMBAT,
  HELMETS,
  SHIELDS,
  WEAPONS,
  MELEE_AI_POOLS,
  MELEE_TUNIC_COLORS,
  TEAM_PALETTE,
  TOURNAMENT,
  TOURNAMENT_AI_POOLS,
  AI_PROFILES,
  FIRST_NAMES,
  EPITHETS,
  meleeReward,
  makeLoadout,
  playerLoadoutForRound,
  rankForLevel,
  maxHpForLevel,
  xpForLevel,
} from '../core/config';
import type {
  Arena,
  FighterInfo,
  GameMode,
  GameUIAPI,
  HudState,
  Loadout,
  MatchStatsView,
  MeleeResultView,
  Profile,
  RoundIntroView,
  RoundResultView,
  Settings,
  TournamentEndView,
  TournamentMember,
  TournamentTeam,
  TournamentView,
} from '../core/types';
import {
  clamp,
  damp,
  distance2D,
  easeInOutCubic,
  hashString,
  mulberry32,
  pick,
  seededShuffle,
  yawTo,
} from '../core/utils';
import { createArena } from '../world/arena';
import { Effects } from '../combat/effects';
import { CombatSystem } from './combat';
import { Fighter, type CombatEvent, type FighterWorld } from './fighter';
import { GameCamera } from './camera';
import { PlayerController } from './player';
import { CombatOverlay } from './overlay';
import { createAIController } from './ai';
import { LoadoutPicker } from './loadout-picker';
import { meleeLoadoutChoices, tournamentLoadoutChoices, type LoadoutChoice } from './loadouts';
import { audio } from '../audio/audio';
import {
  grantDenars,
  grantRenown,
  grantXp,
  recordMelee,
  recordTournament,
  saveProfile,
} from './profile';

/* ------------------------------------------------------------------ */
/* Internal state                                                      */
/* ------------------------------------------------------------------ */

type GameState =
  | 'boot'
  | 'menu'
  | 'bracket'
  | 'loadout'
  | 'intro'
  | 'fighting'
  | 'round-result'
  | 'tournament-end'
  | 'melee-result'
  | 'paused';

interface Contestant {
  id: number;
  name: string;
  isPlayer: boolean;
  appearanceSeed: number;
  alive: boolean;
  kills: number;
  teamId: number;
  aiProfileId: string | null;
}

interface TeamState {
  id: number; // palette index
  name: string;
  color: number;
  colorName: string;
  members: Contestant[];
  isPlayerTeam: boolean;
}

interface TournamentState {
  seed: number;
  rng: () => number;
  roundIndex: number;
  contestants: Contestant[];
  teams: TeamState[];
  playerTeamId: number;
  bet: number;
  stats: {
    kills: number; assists: number; damageDealt: number; damageTaken: number;
    blocks: number; headshots: number; time: number;
  };
  totalRewardDenars: number;
  totalRewardXp: number;
  totalRewardRenown: number;
  lastReward: { denars: number; xp: number; renown: number; bet: number; betWon: number };
  champion: boolean;
  eliminated: boolean;
  lastResult: RoundResultView | null;
  startedAt: number;
  roundStart: number;
  playerLoadout: Loadout | null;
  pendingEnd: { timer: number; winners: number[]; advanced: boolean; champion: boolean } | null;
  matchOver: boolean;
}

interface MeleeState {
  seed: number;
  rng: () => number;
  total: number;
  spawned: number;
  activeMax: number;
  beaten: number;
  defeatedTotal: number;
  startTime: number;
  spawnTimer: number;
  xpEarned: number;
  lastResult: MeleeResultView | null;
  pendingEnd: { timer: number; victory: boolean } | null;
  matchOver: boolean;
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const IDLE_INTENT = { moveX: 0, moveZ: 0, sprint: false };

const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();

export class Game {
  readonly engine: Engine;
  readonly input: Input;
  readonly ui: GameUIAPI;
  readonly overlay: CombatOverlay;
  readonly loadoutPicker: LoadoutPicker;
  readonly arena: Arena;
  readonly effects: Effects;
  readonly cameraCtrl: GameCamera;
  readonly playerCtrl: PlayerController;
  profile: Profile;
  settings: Settings;
  state: GameState = 'boot';
  mode: GameMode = 'tournament';

  private world: FighterWorld;
  private combat: CombatSystem;
  private fighters: Fighter[] = [];
  private player: Fighter | null = null;
  private tournament: TournamentState | null = null;
  private melee: MeleeState | null = null;
  private previousState: GameState = 'menu';
  private time = 0;
  private realTime = 0;
  private freeze = 0;
  private slowMoTimer = 0;
  private introTimer = 0;
  private introDuration = 3.2;
  private introKind: 'tournament' | 'melee' = 'tournament';
  private pendingContinue: 'none' | 'bracket' | 'tournament-end' = 'none';
  private targetRing: THREE.Mesh;
  private targetRingMat: THREE.MeshBasicMaterial;
  private lockTargetId: number | null = null;
  private lowHealthCooldown = 0;
  private botMode = false;
  private seedParam = 0;
  private autoPickIndex = 0;
  private excitement = 0.25;
  private playerDeathHandled = false;
  private killedIds = new Set<number>();
  private lastHudTeams: TournamentTeam[] = [];
  private autoStarted = false;
  private disposed = false;
  private readonly disposeFns: (() => void)[] = [];
  private lastFrameStats = { fps: 60 };
  private playerAssists = 0;
  private pendingLoadoutMode: GameMode | null = null;
  private pendingLoadoutChoices: LoadoutChoice[] = [];
  private damagePulse = 0;
  private fadeMap = new Map<number, number>();
  private cameraBlockers: THREE.Vector3[] = [];

  constructor(engine: Engine, input: Input, ui: GameUIAPI, profile: Profile, settings: Settings) {
    this.engine = engine;
    this.input = input;
    this.ui = ui;
    this.profile = profile;
    this.settings = settings;
    this.overlay = new CombatOverlay();
    this.loadoutPicker = new LoadoutPicker();
    this.effects = new Effects(engine.scene, settings.quality, hashString('effects'));
    this.arena = createArena(engine.scene, engine.renderer, settings.quality);
    this.cameraCtrl = new GameCamera(this.arena, settings);
    this.playerCtrl = new PlayerController(input, this.cameraCtrl, this.overlay, () => this.settings);

    this.world = {
      scene: engine.scene,
      arena: this.arena,
      getFighters: () => this.fighters,
      effects: this.effects,
      audio,
      rng: mulberry32(0xc0ffee),
      time: 0,
      emit: (ev: CombatEvent) => this.handleCombatEvent(ev),
    };
    this.combat = new CombatSystem(this.world);

    const ringGeo = new THREE.RingGeometry(0.5, 0.68, 40);
    this.targetRingMat = new THREE.MeshBasicMaterial({
      color: 0xe8c67a, transparent: true, opacity: 0.0, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    });
    this.targetRing = new THREE.Mesh(ringGeo, this.targetRingMat);
    this.targetRing.rotation.x = -Math.PI / 2;
    this.targetRing.position.y = 0.03;
    this.targetRing.renderOrder = 3;
    engine.scene.add(this.targetRing);

    ui.init(this.profile, this.settings);
    this.bindInput();
    this.applySettings(this.settings, false);
    this.showMenu();

    const unlock = () => audio.unlock();
    document.addEventListener('pointerdown', unlock, { once: true });
    this.disposeFns.push(() => document.removeEventListener('pointerdown', unlock));

    const params = new URLSearchParams(window.location.search);
    this.botMode = params.get('bot') === '1';
    this.seedParam = Number(params.get('seed') || 0);
    this.autoPickIndex = Math.max(0, Math.min(3, Number(params.get('pick') || 0)));
    const quality = params.get('quality');
    if (quality === 'low' || quality === 'medium' || quality === 'high') {
      this.settings = { ...this.settings, quality };
      engine.setQuality(quality);
    }
    if (params.get('autostart')) this.autoStarted = true;
  }

  /* ---------------------------------------------------------------- */
  /* Input / lifecycle                                                 */
  /* ---------------------------------------------------------------- */

  private bindInput(): void {
    this.input.onLockChange = (locked) => {
      if (locked) {
        this.ui.hideControls();
        return;
      }
      if (this.state === 'fighting' || this.state === 'intro') {
        this.pause();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        if (this.state === 'paused') this.resume();
        else if (this.state === 'fighting' || this.state === 'intro') this.pause();
        else if (this.state === 'bracket') this.quitToMenu();
      }
      if ((e.code === 'Enter' || e.code === 'Space') && this.state === 'intro') {
        e.preventDefault();
        this.skipIntro();
      }
      if (e.code === 'Tab' && this.state === 'fighting') {
        e.preventDefault();
        this.overlay.setScoreboard(this.scoreboardHtml());
      }
      if (e.code === 'KeyH' && (this.state === 'fighting' || this.state === 'paused')) {
        e.preventDefault();
        this.applySettings({ ...this.settings, showHints: !this.settings.showHints });
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Tab') this.overlay.setScoreboard(null);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    const canvasClick = () => {
      if ((this.state === 'fighting' || this.state === 'intro') && !this.input.locked) this.input.requestLock();
    };
    this.engine.canvas.addEventListener('click', canvasClick);
    this.disposeFns.push(() => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      this.engine.canvas.removeEventListener('click', canvasClick);
    });
  }

  start(): void {
    if (this.autoStarted) {
      const params = new URLSearchParams(window.location.search);
      const mode = params.get('autostart');
      window.setTimeout(() => {
        if (mode === 'melee' || this.mode === 'melee') this.startMelee();
        else this.startTournament();
      }, 250);
    }
  }

  private showMenu(): void {
    this.state = 'menu';
    this.cleanupFighters();
    this.overlay.setVisible(false);
    this.overlay.setHint(null);
    this.overlay.setScoreboard(null);
    this.loadoutPicker.hide();
    this.ui.hideHUD();
    this.ui.hideBracket();
    this.ui.hidePause();
    this.ui.showMainMenu(this.profile);
    this.cameraCtrl.setOrbit(new THREE.Vector3(0, 2.2, -2), this.realTime * 0.2);
    audio.startMusic('menu');
    audio.setCrowd(0.18);
    this.excitement = 0.22;
    this.input.exitLock();
    this.targetRingMat.opacity = 0;
  }

  /* ---------------------------------------------------------------- */
  /* Tournament setup                                                  */
  /* ---------------------------------------------------------------- */

  startTournament(): void {
    if (this.state !== 'menu' && this.state !== 'tournament-end') return;
    this.mode = 'tournament';
    this.melee = null;
    this.ui.hideMainMenu();
    this.ui.hideControls();
    this.ui.hideSettings();
    this.overlay.setVisible(false);
    this.cleanupFighters();
    const seed = this.seedParam || (Date.now() & 0x7fffffff);
    const rng = mulberry32(seed);
    const contestants: Contestant[] = [];
    const usedNames = new Set<string>();
    contestants.push({
      id: 0,
      name: this.profile.name || 'The Wanderer',
      isPlayer: true,
      appearanceSeed: hashString('player'),
      alive: true,
      kills: 0,
      teamId: 0,
      aiProfileId: null,
    });
    for (let i = 1; i < TOURNAMENT.contestants; i++) {
      let name = '';
      for (let tries = 0; tries < 30; tries++) {
        const first = pick(rng, FIRST_NAMES);
        const epithet = pick(rng, EPITHETS);
        name = rng() > 0.45 ? `${first} ${epithet}` : first;
        if (!usedNames.has(name)) break;
      }
      usedNames.add(name);
      contestants.push({
        id: i,
        name,
        isPlayer: false,
        appearanceSeed: Math.floor(rng() * 0xffffffff),
        alive: true,
        kills: 0,
        teamId: 0,
        aiProfileId: null,
      });
    }
    this.tournament = {
      seed,
      rng,
      roundIndex: 0,
      contestants,
      teams: [],
      playerTeamId: 0,
      bet: 0,
      stats: { kills: 0, assists: 0, damageDealt: 0, damageTaken: 0, blocks: 0, headshots: 0, time: 0 },
      totalRewardDenars: 0,
      totalRewardXp: 0,
      totalRewardRenown: 0,
      lastReward: { denars: 0, xp: 0, renown: 0, bet: 0, betWon: 0 },
      champion: false,
      eliminated: false,
      lastResult: null,
      startedAt: performance.now(),
      roundStart: 0,
      playerLoadout: null,
      pendingEnd: null,
      matchOver: false,
    };
    this.setupRoundTeams(0);
    this.state = 'bracket';
    this.showBracket();
    this.cameraCtrl.setOrbit(new THREE.Vector3(0, 2.2, -3), 0.6);
    audio.startMusic('tournament');
    this.ui.fadeFromBlack(420);
  }

  private setupRoundTeams(roundIndex: number): void {
    const t = this.tournament;
    if (!t) return;
    t.roundIndex = roundIndex;
    t.bet = 0;
    t.pendingEnd = null;
    t.matchOver = false;
    const def = TOURNAMENT.rounds[roundIndex];
    const pool = TOURNAMENT_AI_POOLS[roundIndex] ?? TOURNAMENT_AI_POOLS[0];
    const survivors = t.contestants.filter((c) => c.alive);
    // Guarantee the player is among the survivors when advancing.
    const shuffled = seededShuffle(t.rng, survivors.slice());
    const colors = seededShuffle(t.rng, TEAM_PALETTE.map((p) => p.id)).slice(0, def.teams);
    const teams: TeamState[] = [];
    const perTeam = def.teamSize;
    for (let i = 0; i < def.teams; i++) {
      const palette = TEAM_PALETTE[colors[i]];
      const members = shuffled.slice(i * perTeam, i * perTeam + perTeam);
      if (members.length < perTeam) break;
      for (const m of members) {
        m.teamId = palette.id;
        if (!m.isPlayer) m.aiProfileId = pool[Math.floor(t.rng() * pool.length)];
      }
      teams.push({
        id: palette.id,
        name: palette.name,
        color: palette.color,
        colorName: palette.colorName,
        members,
        isPlayerTeam: members.some((m) => m.isPlayer),
      });
    }
    t.teams = teams;
    const playerTeam = teams.find((tm) => tm.isPlayerTeam);
    t.playerTeamId = playerTeam ? playerTeam.id : -1;
    t.roundStart = 0;
    t.playerLoadout = playerTeam
      ? tournamentLoadoutChoices(roundIndex, playerTeam.color, TEAM_PALETTE[playerTeam.id].secondary)[0].loadout
      : null;
  }

  private showBracket(): void {
    const t = this.tournament;
    if (!t) return;
    this.state = 'bracket';
    this.ui.showBracket(this.buildTournamentView());
    this.ui.setLoading(null);
    this.ui.setProfile(this.profile);
  }

  private buildTournamentView(): TournamentView {
    const t = this.tournament!;
    const def = TOURNAMENT.rounds[t.roundIndex];
    return {
      round: t.roundIndex + 1,
      totalRounds: TOURNAMENT.rounds.length,
      roundName: def.name,
      roundObjective: def.objective,
      mode: 'tournament',
      purse: def.purse,
      denars: this.profile.denars,
      bet: t.bet,
      maxBet: Math.min(TOURNAMENT.maxBet, this.profile.denars),
      canBet: true,
      playerTeam: t.playerTeamId,
      teams: this.teamViews(),
      survivors: t.contestants.filter((c) => c.alive).map((c) => this.memberView(c)),
      playerLoadout: t.playerLoadout ?? playerLoadoutForRound(t.roundIndex, 0x8e2f2b, 0xd9c9a3, t.rng),
      arenaName: ARENA_NAME,
      isFinal: t.roundIndex === TOURNAMENT.rounds.length - 1,
    };
  }

  placeBet(amount: number): void {
    const t = this.tournament;
    if (!t || this.state !== 'bracket') return;
    const max = Math.min(TOURNAMENT.maxBet, this.profile.denars);
    t.bet = clamp(Math.round(amount), 0, max);
    this.showBracket();
    audio.play('bet', { volume: 0.5 });
  }

  enterRound(): void {
    const t = this.tournament;
    if (!t || this.state !== 'bracket') return;
    if (t.bet > this.profile.denars) t.bet = 0;
    if (t.bet > 0) {
      this.profile.denars -= t.bet;
      saveProfile(this.profile);
      this.ui.setProfile(this.profile);
    }
    this.ui.hideBracket();
    this.input.exitLock();
    const team = t.teams.find((x) => x.isPlayerTeam);
    const color1 = team?.color ?? 0x8e2f2b;
    const color2 = team ? TEAM_PALETTE[team.id].secondary : 0xd9c9a3;
    const def = TOURNAMENT.rounds[t.roundIndex];
    const choices = tournamentLoadoutChoices(t.roundIndex, color1, color2);
    this.pendingLoadoutMode = 'tournament';
    this.pendingLoadoutChoices = choices;
    this.state = 'loadout';
    this.overlay.setVisible(false);
    this.loadoutPicker.show({
      mode: 'tournament',
      heading: `Round ${t.roundIndex + 1} of ${TOURNAMENT.rounds.length} — ${def.name}`,
      subtitle: 'The armoury is open. Choose the arms you will carry into the lists.',
    }, choices, (loadout) => this.confirmLoadout(loadout), () => this.cancelLoadout());
    // Debug/autostart runs skip the interactive pick.
    if (this.autoStarted || this.botMode) {
      this.loadoutPicker.hide();
      this.confirmLoadout(choices[this.autoPickIndex]?.loadout ?? choices[0].loadout);
    }
  }

  private updateLoadout(dt: number): void {
    this.arena.update(dt, this.realTime);
    this.arena.setExcitement(0.28);
    this.effects.update(dt);
    this.cameraCtrl.setOrbit(new THREE.Vector3(0, 2.4, -2.5), this.realTime * 0.05);
    this.cameraCtrl.update(dt, new THREE.Vector3(0, 2.4, -2.5));
    this.cameraCtrl.applyTo(this.engine.camera);
  }

  private cancelLoadout(): void {
    const t = this.tournament;
    if (this.pendingLoadoutMode === 'tournament' && t) {
      if (t.bet > 0) {
        grantDenars(this.profile, t.bet);
        t.bet = 0;
        saveProfile(this.profile);
        this.ui.setProfile(this.profile);
      }
      this.pendingLoadoutMode = null;
      this.pendingLoadoutChoices = [];
      this.state = 'bracket';
      this.showBracket();
      return;
    }
    this.pendingLoadoutMode = null;
    this.pendingLoadoutChoices = [];
    this.quitToMenu();
  }

  private confirmLoadout(loadout: Loadout): void {
    if (this.state !== 'loadout') return;
    const mode = this.pendingLoadoutMode;
    this.pendingLoadoutMode = null;
    this.pendingLoadoutChoices = [];
    this.loadoutPicker.hide();
    this.input.requestLock();
    if (mode === 'tournament' && this.tournament) {
      this.tournament.playerLoadout = loadout;
      this.spawnRound(this.tournament.roundIndex);
      this.beginIntro('tournament');
    } else if (mode === 'melee') {
      this.beginMelee(loadout);
    }
  }

  private spawnRound(roundIndex: number): void {
    const t = this.tournament!;
    const def = TOURNAMENT.rounds[roundIndex];
    this.cleanupFighters();
    t.pendingEnd = null;
    t.matchOver = false;
    this.playerDeathHandled = false;
    this.playerAssists = 0;
    this.killedIds.clear();
    this.freeze = 0;
    this.slowMoTimer = 0;
    this.lockTargetId = null;
    this.playerCtrl.reset();
    const rng = t.rng;
    const palettes = t.teams.map((team) => TEAM_PALETTE[team.id]);
    t.teams.forEach((team, teamOrder) => {
      team.members.forEach((member, memberIndex) => {
        if (!member.alive) return;
        const spawn = this.roundSpawn(teamOrder, memberIndex);
        const palette = palettes[teamOrder];
        const loadout = member.isPlayer
          ? (t.playerLoadout ?? playerLoadoutForRound(roundIndex, palette.color, palette.secondary, rng))
          : makeLoadout({
            tier: def.loadoutTier,
            color1: palette.color,
            color2: palette.secondary,
            title: def.loadoutTitle,
            rng,
          });
        const yaw = yawTo(spawn.position, new THREE.Vector3(0, 0, 0));
        const profile = AI_PROFILES[member.aiProfileId ?? 'fighter'] ?? AI_PROFILES.fighter;
        const cfg = {
          id: member.id,
          name: member.name,
          team: team.id,
          isPlayer: member.isPlayer,
          loadout,
          appearanceSeed: member.appearanceSeed,
          quality: this.settings.quality,
          aiProfile: member.isPlayer ? undefined : profile,
          level: member.isPlayer ? this.profile.level : 1,
          spawn: { position: spawn.position.clone(), yaw },
        };
        const fighter = new Fighter(cfg, this.world);
        if (member.isPlayer) {
          this.player = fighter;
          this.playerCtrl.reset();
          if (this.botMode) {
            fighter.attachAI(createAIController(AI_PROFILES.champion, hashString(`${t.seed}:bot`)));
          }
        } else {
          fighter.attachAI(createAIController(profile, hashString(`${t.seed}:${member.id}:${roundIndex}`)));
        }
        this.fighters.push(fighter);
      });
    });
    // Face all fighters toward the centre of the lists.
    for (const f of this.fighters) {
      f.yaw = yawTo(f.position, new THREE.Vector3(0, 0, 0));
      f.rig.root.rotation.y = f.yaw;
    }
    t.roundStart = this.time;
  }

  /** Spread a team in a loose wedge pulled in from its corner so nobody spawns inside a prop or the camera. */
  private roundSpawn(teamOrder: number, memberIndex: number): { position: THREE.Vector3; yaw: number } {
    const groups = this.arena.teamSpawns;
    const group = groups[teamOrder % Math.max(1, groups.length)] ?? groups[0];
    const anchor = group?.[0]?.position.clone() ?? this.arena.playerSpawn.position.clone();
    const center = new THREE.Vector3(0, 0, 0);
    const inward = center.clone().sub(anchor).setY(0);
    if (inward.lengthSq() < 0.001) inward.set(0, 0, 1);
    inward.normalize();
    const side = new THREE.Vector3(-inward.z, 0, inward.x);
    const lateral = memberIndex === 0 ? 0 : (memberIndex % 2 === 1 ? 1 : -1) * (1.35 + Math.floor(memberIndex / 2) * 1.15);
    const depth = memberIndex >= 2 ? 1.25 : 0;
    const base = anchor.addScaledVector(inward, 3.1);
    const pos = base.addScaledVector(inward, depth).addScaledVector(side, lateral);
    pos.y = 0;
    this.arena.clampPosition(pos, 0.5);
    return { position: pos, yaw: Math.atan2(center.x - pos.x, center.z - pos.z) };
  }

  /* ---------------------------------------------------------------- */
  /* Melee setup                                                       */
  /* ---------------------------------------------------------------- */

  startMelee(): void {
    if (this.state !== 'menu' && this.state !== 'tournament-end' && this.state !== 'melee-result') return;
    this.mode = 'melee';
    this.tournament = null;
    this.ui.hideMainMenu();
    this.ui.hideControls();
    this.ui.hideSettings();
    this.cleanupFighters();
    this.input.exitLock();
    this.pendingLoadoutMode = 'melee';
    this.pendingLoadoutChoices = meleeLoadoutChoices();
    this.state = 'loadout';
    this.loadoutPicker.show({
      mode: 'melee',
      heading: 'Arena Melee — thirty-five foes, one sand',
      subtitle: 'Survive the yard. Choose what you carry into the crowd.',
    }, this.pendingLoadoutChoices, (loadout) => this.confirmLoadout(loadout), () => this.cancelLoadout());
    if (this.autoStarted || this.botMode) {
      this.loadoutPicker.hide();
      this.confirmLoadout(this.pendingLoadoutChoices[this.autoPickIndex]?.loadout ?? this.pendingLoadoutChoices[0].loadout);
    }
  }

  private beginMelee(loadout: Loadout): void {
    this.state = 'intro';
    const seed = this.seedParam || (Date.now() & 0x7fffffff);
    const rng = mulberry32(seed);
    this.melee = {
      seed,
      rng,
      total: COMBAT.melee.totalOpponents,
      spawned: 0,
      activeMax: COMBAT.melee.activeMin,
      beaten: 0,
      defeatedTotal: 0,
      startTime: this.time,
      spawnTimer: 0,
      xpEarned: 0,
      lastResult: null,
      pendingEnd: null,
      matchOver: false,
    };
    this.playerDeathHandled = false;
    this.playerAssists = 0;
    this.killedIds.clear();
    this.freeze = 0;
    this.slowMoTimer = 0;
    this.lockTargetId = null;
    this.excitement = 0.3;
    const spawn = this.arena.playerSpawn;
    this.player = new Fighter({
      id: 0,
      name: this.profile.name || 'The Wanderer',
      team: -1,
      isPlayer: true,
      loadout,
      appearanceSeed: hashString('player'),
      quality: this.settings.quality,
      level: this.profile.level,
      spawn: { position: spawn.position.clone(), yaw: spawn.yaw },
    }, this.world);
    this.playerCtrl.reset();
    if (this.botMode) this.player.attachAI(createAIController(AI_PROFILES.champion, hashString('melee:bot')));
    this.fighters.push(this.player);
    const initial = [
      new THREE.Vector3(-10, 0, 2),
      new THREE.Vector3(10, 0, 2),
      new THREE.Vector3(-4, 0, 6),
      new THREE.Vector3(4, 0, 6),
    ];
    for (const pos of initial) {
      this.arena.clampPosition(pos, 0.6);
      this.spawnMeleeEnemy(true, pos);
    }
    this.beginIntro('melee');
    audio.startMusic('melee');
  }

  private spawnMeleeEnemy(silentSpawn = false, at?: THREE.Vector3): void {
    const m = this.melee;
    if (!m || m.spawned >= m.total) return;
    const progress = m.defeatedTotal / m.total;
    let profileId = 'fighter';
    const roll = m.rng();
    let acc = 0;
    for (const bucket of MELEE_AI_POOLS) {
      acc += bucket.share;
      if (roll <= acc) {
        profileId = bucket.pool[Math.floor(m.rng() * bucket.pool.length)];
        break;
      }
    }
    if (progress > 0.75) profileId = m.rng() > 0.45 ? 'champion' : 'duelist';
    else if (progress > 0.45) profileId = m.rng() > 0.5 ? 'veteran' : 'brute';
    const profile = AI_PROFILES[profileId] ?? AI_PROFILES.fighter;
    const spawnPoint = at ? { position: at.clone(), yaw: this.player ? yawTo(at, this.player.position) : 0 } : this.pickMeleeSpawn();
    const color1 = MELEE_TUNIC_COLORS[Math.floor(m.rng() * MELEE_TUNIC_COLORS.length)];
    const color2 = 0xd9c9a3;
    const loadout = makeLoadout({
      tier: Math.min(4, 1 + Math.floor(m.defeatedTotal / 9)),
      color1,
      color2,
      title: profile.name,
      rng: m.rng,
    });
    const id = 100 + m.spawned;
    const enemy = new Fighter({
      id,
      name: profile.name,
      team: -1,
      isPlayer: false,
      loadout,
      appearanceSeed: Math.floor(m.rng() * 0xffffffff),
      quality: this.settings.quality,
      aiProfile: profile,
      spawn: {
        position: spawnPoint.position.clone(),
        yaw: yawTo(spawnPoint.position, this.player?.position ?? new THREE.Vector3()),
      },
    }, this.world);
    enemy.attachAI(createAIController(profile, hashString(`melee:${m.seed}:${id}`)));
    this.fighters.push(enemy);
    m.spawned++;
    if (!silentSpawn) {
      this.effects.dustPuff(spawnPoint.position, 6, 1.2);
    }
  }

  private pickMeleeSpawn(): { position: THREE.Vector3; yaw: number } {
    const spawns = this.arena.spawns;
    const rng = this.melee?.rng ?? Math.random;
    let best = spawns[0]?.clone() ?? new THREE.Vector3(0, 0, 12);
    let bestScore = -Infinity;
    for (let i = 0; i < 14; i++) {
      const base = spawns[Math.floor(rng() * spawns.length)];
      if (!base) continue;
      const cand = base.clone();
      cand.x += (rng() - 0.5) * 3.2;
      cand.z += (rng() - 0.5) * 3.2;
      cand.y = 0;
      this.arena.clampPosition(cand, 0.6);
      // Prefer gates far from the player and clear of other fighters.
      const playerDist = this.player ? distance2D(cand, this.player.position) : 12;
      let nearestFighter = Infinity;
      for (const f of this.fighters) {
        if (!f.alive || f.state === 'spawn') continue;
        nearestFighter = Math.min(nearestFighter, distance2D(cand, f.position));
      }
      if (nearestFighter < 1.5) continue;
      const score = Math.min(playerDist, 18) * 1.4 + Math.min(nearestFighter, 10) + rng() * 4;
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    return {
      position: best,
      yaw: this.player ? yawTo(best, this.player.position) : 0,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Intro / fight flow                                                */
  /* ---------------------------------------------------------------- */

  private beginIntro(kind: 'tournament' | 'melee'): void {
    this.state = 'intro';
    this.introKind = kind;
    this.introTimer = this.introDuration;
    this.overlay.setVisible(false);
    this.ui.hideHUD();
    audio.play('horn', { volume: 0.7 });
    this.arena.cheer(0.5);
    if (kind === 'tournament' && this.tournament) {
      const t = this.tournament;
      const def = TOURNAMENT.rounds[t.roundIndex];
      const view: RoundIntroView = {
        round: t.roundIndex + 1,
        totalRounds: TOURNAMENT.rounds.length,
        roundName: def.name,
        objective: def.objective,
        teams: this.teamViews(),
        mode: 'tournament',
        loadout: t.playerLoadout ?? playerLoadoutForRound(t.roundIndex, 0x8e2f2b, 0xd9c9a3, t.rng),
        isFinal: t.roundIndex === TOURNAMENT.rounds.length - 1,
      };
      this.ui.showRoundIntro(view);
    } else {
      this.ui.showRoundIntro({
        round: 1,
        totalRounds: 1,
        roundName: 'Arena Melee',
        objective: 'Survive the sand. Every fighter in the yard wants your blood.',
        teams: [],
        mode: 'melee',
        loadout: this.player?.loadout ?? makeLoadout({ tier: 2, color1: 0x8e2f2b, color2: 0xd9c9a3, title: 'Arena Arms', rng: mulberry32(1) }),
        isFinal: false,
      });
    }
    this.cameraCtrl.setFixed(
      new THREE.Vector3(0, 9.5, -19),
      new THREE.Vector3(0, 1.4, 6),
    );
  }

  private skipIntro(): void {
    if (this.state !== 'intro') return;
    this.introTimer = 0;
    this.beginFight();
  }

  private beginFight(): void {
    this.state = 'fighting';
    this.ui.hideRoundIntro();
    this.ui.showHUD(this.mode);
    this.overlay.setVisible(true);
    this.overlay.showCenterText('FIGHT', 1.5);
    this.input.requestLock();
    this.playerCtrl.reset();
    this.overlay.setHint(null);
    if (this.mode === 'tournament' && this.tournament) {
      this.tournament.roundStart = this.time;
    } else if (this.mode === 'melee' && this.melee) {
      this.melee.startTime = this.time;
    }
    this.cameraCtrl.setFollow();
    this.cameraCtrl.yaw = this.player?.yaw ?? Math.PI;
    audio.play('gong', { volume: 0.8 });
    audio.cheer(0.55);
    this.arena.cheer(0.8);
  }

  private controlHint(): string {
    if (!this.input.locked) return 'Click the sand to capture the mouse';
    return 'LMB hold + drag = attack  ·  RMB hold + drag = guard  ·  Space dodge  ·  F kick  ·  Q lock target';
  }

  private scoreboardHtml(): string {
    if (this.mode === 'melee' && this.melee) {
      const m = this.melee;
      return `<h4>THE ARENA</h4><div class="row"><span class="nm">Opponents Beaten</span><span class="ct">${m.beaten}</span></div><div class="row"><span class="nm">Opponents Remaining</span><span class="ct">${m.total - m.defeatedTotal}</span></div><div class="sub">HOLD TAB TO READ THE SANDS</div>`;
    }
    if (!this.tournament) return '';
    const teams = this.teamViews();
    const rows = teams.map((team) => {
      const pips = team.members.map((m) => `<span class="pip ${m.alive ? 'on' : ''}"></span>`).join('');
      return `<div class="row ${team.isPlayerTeam ? 'you' : ''}"><span class="dot" style="background:${team.color}"></span><span class="nm">${team.name}${team.isPlayerTeam ? ' · YOUR HOUSE' : ''}</span><span class="pips">${pips}</span><span class="ct">${team.alive}/${team.members.length}</span></div>`;
    }).join('');
    const def = TOURNAMENT.rounds[this.tournament.roundIndex];
    return `<h4>${def.name.toUpperCase()} · ROUND ${this.tournament.roundIndex + 1} OF ${TOURNAMENT.rounds.length}</h4>${rows}<div class="sub">${def.objective.toUpperCase()}</div>`;
  }

  private scoreboardHint(): string {
    if (this.mode === 'tournament' && this.tournament) {
      return this.teamViews().map((team) => `${team.colorName}: ${team.alive}/${team.members.length}`).join('   ·   ');
    }
    return `Opponents Beaten ${this.melee?.beaten ?? 0} · Remaining ${(this.melee?.total ?? 0) - (this.melee?.defeatedTotal ?? 0)}`;
  }

  /* ---------------------------------------------------------------- */
  /* Main update                                                       */
  /* ---------------------------------------------------------------- */

  update(dt: number): void {
    const realDt = Math.min(0.05, dt);
    this.lastFrameStats.fps = this.lastFrameStats.fps * 0.92 + (1 / Math.max(0.001, realDt)) * 0.08;
    this.realTime += realDt;
    this.lowHealthCooldown = Math.max(0, this.lowHealthCooldown - realDt);
    this.overlay.update(realDt);

    if (this.state === 'menu') {
      this.updateMenu(realDt);
    } else if (this.state === 'bracket') {
      this.updateBracket(realDt);
    } else if (this.state === 'loadout') {
      this.updateLoadout(realDt);
    } else if (this.state === 'intro') {
      this.updateIntro(realDt);
    } else if (this.state === 'fighting') {
      this.updateFighting(realDt);
    } else if (this.state === 'round-result' || this.state === 'tournament-end' || this.state === 'melee-result') {
      this.updateResults(realDt);
    } else if (this.state === 'paused') {
      this.arena.update(0, this.time);
    }

    this.damagePulse = Math.max(0, this.damagePulse - realDt * 1.6);
    this.engine.setDamagePulse(this.damagePulse);
    audio.update(this.engine.camera, realDt);
  }

  private updateMenu(dt: number): void {
    this.arena.update(dt, this.realTime);
    this.arena.setExcitement(0.2 + Math.sin(this.realTime * 0.3) * 0.05);
    this.effects.update(dt);
    const angle = this.realTime * 0.035 + 0.4;
    const r = 18.5;
    _v1.set(Math.sin(angle) * r, 7.5 + Math.sin(this.realTime * 0.21) * 0.35, Math.cos(angle) * r - 3.5);
    _v2.set(0, 2.4, -3);
    this.cameraCtrl.setCinematic(_v1, _v2);
    this.cameraCtrl.applyTo(this.engine.camera);
    this.cameraCtrl.fov = this.settings.fov;
    this.updateHudTargetOnly();
    void dt;
  }

  private updateBracket(dt: number): void {
    this.arena.update(dt, this.realTime);
    this.arena.setExcitement(0.3 + Math.sin(this.realTime * 0.4) * 0.06);
    this.effects.update(dt);
    this.cameraCtrl.setOrbit(new THREE.Vector3(0, 2.4, -2.5), this.realTime * 0.05);
    _v1.set(0, 2.4, -2.5);
    this.cameraCtrl.update(dt, _v1);
    this.cameraCtrl.applyTo(this.engine.camera);
  }

  private updateIntro(dt: number): void {
    this.introTimer -= dt;
    const t = clamp(1 - this.introTimer / this.introDuration, 0, 1);
    const e = easeInOutCubic(Math.min(1, t * 1.08));
    this.arena.update(dt, this.time);
    this.arena.setExcitement(0.45 + t * 0.3);
    this.effects.update(dt);
    const playerPos = this.player?.position ?? new THREE.Vector3(0, 0, 10);
    const playerYaw = this.player?.yaw ?? Math.PI;
    const behind = new THREE.Vector3(
      playerPos.x - Math.sin(playerYaw) * 3.15,
      playerPos.y + 1.7,
      playerPos.z - Math.cos(playerYaw) * 3.15,
    );
    const startPos = new THREE.Vector3(0, 10.5, -20);
    const startLook = new THREE.Vector3(0, 1.4, 5);
    const endLook = new THREE.Vector3(playerPos.x, 1.35, playerPos.z);
    _v1.copy(startPos).lerp(behind, e);
    _v1.y += Math.sin(e * Math.PI) * 1.2;
    _v2.copy(startLook).lerp(endLook, e * 0.85);
    this.cameraCtrl.setCinematic(_v1, _v2);
    this.cameraCtrl.applyTo(this.engine.camera);
    this.cameraCtrl.fov = this.settings.fov;

    // idle animation for fighters during the intro
    for (const f of this.fighters) {
      f.rig.update(dt);
    }
    if (this.introTimer <= 0) this.beginFight();
  }

  private updateFighting(realDt: number): void {
    // Hit-stop / slow motion
    let simDt = realDt;
    if (this.freeze > 0) {
      this.freeze -= realDt;
      simDt = realDt * 0.06;
    } else if (this.slowMoTimer > 0) {
      this.slowMoTimer -= realDt;
      simDt = realDt * 0.32;
    }
    this.time += simDt;
    this.world.time = this.time;
    this.world.rng = this.tournament?.rng ?? this.melee?.rng ?? Math.random;

    const player = this.player;
    const infos: FighterInfo[] = this.fighters.map((f) => f.toInfo());

    // Intents
    for (let i = 0; i < this.fighters.length; i++) {
      const f = this.fighters[i];
      if (!f.alive) continue;
      let intent;
      if (f.isPlayer) {
        if (this.botMode && f.ai) {
          intent = f.ai.update({
            self: infos[i], fighters: infos, arena: this.arena, time: this.time, dt: simDt, playerId: f.id,
          });
          this.cameraCtrl.yaw = f.yaw;
        } else {
          intent = this.playerCtrl.update(simDt, f, this.fighters);
        }
      } else if (f.ai) {
        intent = f.ai.update({
          self: infos[i], fighters: infos, arena: this.arena, time: this.time, dt: simDt, playerId: player?.id ?? -1,
        });
      } else {
        intent = { moveX: 0, moveZ: 0, sprint: false };
      }
      if (intent.faceYaw === undefined) {
        const target = this.nearestEnemy(f);
        if (target) intent.faceYaw = yawTo(f.position, target.position);
      }
      f.update(simDt, intent, this.world);
    }
    // Dead fighters still need to advance their collapse animation / corpse timer.
    for (const f of this.fighters) {
      if (!f.alive) f.update(simDt, IDLE_INTENT, this.world);
    }

    this.combat.update(simDt, this.fighters);

    // Clean up old corpses (keep the player's body for the defeat camera).
    for (let i = this.fighters.length - 1; i >= 0; i--) {
      const f = this.fighters[i];
      if (!f.alive && !f.isPlayer && f.deadTime > (this.mode === 'melee' ? 10 : 22)) {
        this.fadeMap.delete(f.id);
        f.dispose();
        this.fighters.splice(i, 1);
      }
    }

    // Player death handling
    if (player && !player.alive && !this.playerDeathHandled) {
      this.playerDeathHandled = true;
      this.cameraCtrl.setDead();
      this.overlay.setVisible(false);
      this.overlay.setHint(null);
      this.ui.setTargetOverlay(null);
      audio.play('defeat', { volume: 0.7 });
      this.slowMoTimer = 1.4;
      this.arena.setExcitement(0.1);
      if (this.mode === 'melee') {
        this.scheduleMeleeEnd(false);
      } else {
        this.ui.pushLog({ text: 'You have been struck down. The crowd gasps.', kind: 'warning' });
        this.checkTournamentEnd();
      }
    }

    this.effects.update(simDt);
    this.arena.update(simDt, this.time);
    this.excitement = clamp(this.excitement - simDt * 0.09, 0.18, 1);
    this.arena.setExcitement(this.excitement);

    // Camera
    if (player && player.alive) {
      this.cameraBlockers.length = 0;
      for (const f of this.fighters) {
        if (!f.alive || f === player) continue;
        this.cameraBlockers.push(_v3.copy(f.position).setY(1.15));
      }
      this.cameraCtrl.update(realDt, player.position, {
        sprint: player.velocity.length() > 5.1,
        moving: player.velocity.lengthSq() > 0.2,
        blockers: this.cameraBlockers,
      });
    } else if (player) {
      this.cameraCtrl.update(realDt, player.position);
    }
    this.cameraCtrl.applyTo(this.engine.camera);
    this.updateFightersNearCamera();

    // Out-of-combat regen in the arena melee.
    if (this.mode === 'melee' && player?.alive) {
      if (this.time - player.lastDamageTime > COMBAT.melee.regenDelay && player.hp < player.maxHp) {
        player.hp = Math.min(player.maxHp, player.hp + COMBAT.melee.outOfCombatRegen * simDt);
      }
    }

    // Melee spawning / end
    if (this.mode === 'melee' && this.melee) {
      const m = this.melee;
      if (!m.matchOver) {
        const activeEnemies = this.fighters.filter((f) => f.alive && !f.isPlayer).length;
        m.activeMax = Math.min(COMBAT.melee.activeMax, COMBAT.melee.activeMin + Math.floor(m.defeatedTotal / 7));
        m.spawnTimer -= simDt;
        if (m.spawnTimer <= 0 && activeEnemies < m.activeMax && m.spawned < m.total) {
          this.spawnMeleeEnemy();
          m.spawnTimer = COMBAT.melee.spawnInterval;
        }
        if (m.spawned < m.total && m.spawnTimer <= 0 && activeEnemies < 3) {
          this.spawnMeleeEnemy();
          m.spawnTimer = 0.6;
        }
        if (m.defeatedTotal >= m.total) this.scheduleMeleeEnd(true);
      }
    } else if (this.mode === 'tournament') {
      this.checkTournamentEnd();
    }

    // Target ring / lock
    this.updateCameraLock();
    this.updateTargetRing();

    // HUD every frame (cheap enough; UI implementation may throttle internally)
    this.updateHud();

    // Feedback: crowd
    audio.setCrowd(0.22 + this.excitement * 0.5);
    if (this.playerDeathHandled) {
      // let the fight finish / watch until the round resolves
    }
  }

  /** Fade fighters that end up between the camera and the player so a shield never fills the screen. */
  private updateFightersNearCamera(): void {
    const cam = this.cameraCtrl.position;
    const pivot = _v1.copy(this.player?.position ?? new THREE.Vector3()).setY(1.45);
    const seg = _v3.copy(cam).sub(pivot);
    const segLenSq = Math.max(0.001, seg.lengthSq());
    for (const f of this.fighters) {
      if (f === this.player) continue;
      if (!f.alive) {
        if (this.fadeMap.has(f.id)) {
          this.fadeMap.delete(f.id);
          f.rig.setOpacity(1);
          f.rig.root.visible = true;
        }
        continue;
      }
      const chest = _v2.copy(f.position).setY(1.25);
      const camDist = cam.distanceTo(chest);
      // distance from the fighter to the camera->player line
      const t = clamp(_v4.copy(chest).sub(pivot).dot(seg) / segLenSq, 0, 1);
      const closest = _v5.copy(pivot).addScaledVector(seg, t);
      const lineDist = closest.distanceTo(chest);
      let target = 1;
      if (camDist < 2.4) target = Math.max(0.08, (camDist - 0.4) / 2.0);
      if (lineDist < 1.0 && t > 0.05) target = Math.min(target, Math.max(0.08, (lineDist - 0.15) / 0.85));
      target = clamp(target, 0.08, 1);
      const prev = this.fadeMap.get(f.id) ?? 1;
      if (Math.abs(target - prev) > 0.04) {
        this.fadeMap.set(f.id, target);
        f.rig.setOpacity(target);
        f.rig.root.visible = target > 0.05;
      }
    }
  }

  private updateResults(dt: number): void {
    this.arena.update(dt, this.time);
    this.arena.setExcitement(0.5);
    this.effects.update(dt);
    // Victory / defeat animations for any standing fighters.
    for (const f of this.fighters) {
      if (f.alive && f.state === 'idle') f.rig.update(dt);
      else if (!f.alive) f.rig.update(dt);
    }
    const center = this.player?.position.clone() ?? new THREE.Vector3(0, 0, 0);
    center.setY(0);
    if (this.mode === 'melee') this.cameraCtrl.setDead();
    else this.cameraCtrl.setOrbit(new THREE.Vector3(0, 2, 0), this.realTime * 0.06);
    this.cameraCtrl.update(dt, this.mode === 'melee' ? center : new THREE.Vector3(0, 2, 0));
    this.cameraCtrl.applyTo(this.engine.camera);
    this.updateHudTargetOnly();
  }

  private updateCameraLock(): void {
    const player = this.player;
    if (!player) {
      this.lockTargetId = null;
      return;
    }
    this.lockTargetId = this.playerCtrl.lockedId;
  }

  private updateTargetRing(): void {
    const fighter = this.lockTargetId != null ? this.fighters.find((f) => f.id === this.lockTargetId && f.alive) : null;
    if (fighter && this.state === 'fighting') {
      this.targetRing.position.set(fighter.position.x, 0.04, fighter.position.z);
      const pulse = 0.55 + Math.sin(this.realTime * 5) * 0.12;
      this.targetRingMat.opacity = damp(this.targetRingMat.opacity, pulse, 10, 0.016);
      this.targetRing.visible = true;
    } else {
      this.targetRingMat.opacity = damp(this.targetRingMat.opacity, 0, 12, 0.016);
      this.targetRing.visible = this.targetRingMat.opacity > 0.02;
    }
  }

  private nearestEnemy(f: Fighter): Fighter | null {
    let best: Fighter | null = null;
    let bestD = Infinity;
    for (const other of this.fighters) {
      if (!other.alive || other === f) continue;
      if (f.team >= 0 && other.team === f.team) continue;
      const d = distance2D(f.position, other.position);
      if (d < bestD) {
        bestD = d;
        best = other;
      }
    }
    return best;
  }

  /* ---------------------------------------------------------------- */
  /* Combat feedback                                                   */
  /* ---------------------------------------------------------------- */

  private handleCombatEvent(ev: CombatEvent): void {
    const player = this.player;
    const info = ev.info;
    switch (ev.type) {
      case 'hit': {
        if (!info) break;
        if (ev.attacker?.isPlayer) {
          this.overlay.hitFeedback('hit');
          this.engine.setDamagePulse(0.18);
          this.cameraCtrl.addShake(clamp(0.14 + info.damage / 150, 0.12, 0.45) * this.settings.cameraShake);
          this.freeze = Math.max(this.freeze, COMBAT.hitStopHit);
          if (!info.friendlyFire) {
            this.ui.pushLog({ text: `Delivered ${Math.round(info.damage)} damage`, kind: 'damage' });
            if (info.zone === 'head') this.ui.pushLog({ text: 'A blow to the head!', kind: 'damage' });
            if (info.speedBonus > 0.06) {
              this.ui.pushLog({ text: `Speed bonus: +${Math.round(info.speedBonus * 100)}%`, kind: 'info' });
            }
          } else {
            this.ui.pushLog({ text: 'You struck one of your own!', kind: 'warning' });
          }
          this.excitement = clamp(this.excitement + 0.08, 0, 1);
        }
        if (ev.defender?.isPlayer) {
          this.ui.setDamagePulse(clamp(0.4 + info.damage / 90, 0.4, 1));
          this.damagePulse = clamp(0.55 + info.damage / 80, 0.5, 1);
          this.cameraCtrl.addShake(clamp(0.2 + info.damage / 100, 0.2, 0.6) * this.settings.cameraShake);
          this.ui.pushLog({ text: `Took ${Math.round(info.damage)} damage`, kind: 'warning' });
          this.freeze = Math.max(this.freeze, COMBAT.hitStopHit * 0.8);
        }
        break;
      }
      case 'block': {
        if (ev.defender?.isPlayer) {
          const shield = ev.defender.loadout.shield;
          this.overlay.hitFeedback('block');
          this.ui.pushLog({
            text: `Blocked ${Math.round(info?.rawDamage ?? 0)} damage with your ${shield ? 'shield' : 'blade'}`,
            kind: 'block',
          });
          this.cameraCtrl.addShake(0.12 * this.settings.cameraShake);
          this.freeze = Math.max(this.freeze, COMBAT.hitStopBlock * 0.7);
        } else if (ev.attacker?.isPlayer) {
          this.ui.pushLog({ text: `${ev.defender?.name ?? 'The enemy'} blocked your blow`, kind: 'block' });
          this.overlay.hitFeedback('block');
          this.cameraCtrl.addShake(0.08 * this.settings.cameraShake);
          this.freeze = Math.max(this.freeze, COMBAT.hitStopBlock);
        }
        break;
      }
      case 'guard-break': {
        if (ev.defender?.isPlayer) {
          this.ui.pushLog({ text: 'Your guard was broken!', kind: 'warning' });
          this.cameraCtrl.addShake(0.4 * this.settings.cameraShake);
        } else if (ev.attacker?.isPlayer) {
          this.ui.pushLog({ text: `${ev.defender?.name ?? 'The enemy'}'s guard is broken!`, kind: 'kill' });
          this.overlay.hitFeedback('hit');
        }
        break;
      }
      case 'kick': {
        if (ev.attacker?.isPlayer) {
          this.ui.pushLog({ text: `You kicked ${ev.defender?.name ?? 'the enemy'} off balance`, kind: 'damage' });
          this.overlay.hitFeedback('hit');
        } else if (ev.defender?.isPlayer) {
          this.ui.pushLog({ text: 'You were kicked off balance!', kind: 'warning' });
          this.cameraCtrl.addShake(0.25 * this.settings.cameraShake);
        }
        break;
      }
      case 'kill': {
        const dead = ev.defender;
        if (!dead) break;
        if ((this.mode === 'melee' || this.mode === 'tournament') && !dead.isPlayer && ev.attacker && !ev.attacker.isPlayer && this.player && this.player.alive) {
          if (dead.wasDamagedRecentlyBy(this.player.id, 8, this.time) && dead.team !== this.player.team) this.playerAssists++;
        }
        if (this.mode === 'melee' && this.melee && !dead.isPlayer) {
          this.melee.defeatedTotal++;
          if (this.melee.defeatedTotal >= this.melee.total) this.scheduleMeleeEnd(true);
        }
        if (ev.attacker?.isPlayer) {
          if (info?.friendlyFire) {
            this.ui.pushLog({ text: `You struck down ${dead.name} — one of your own!`, kind: 'warning' });
            this.overlay.hitFeedback('hit');
          } else {
            this.onPlayerKill(dead);
          }
        } else if (dead.isPlayer) {
          this.onPlayerDeath();
        }
        break;
      }
      case 'low-health': {
        if (ev.defender?.isPlayer && this.lowHealthCooldown <= 0) {
          this.lowHealthCooldown = 14;
          this.ui.pushLog({ text: 'You are badly wounded — guard yourself!', kind: 'warning' });
        }
        break;
      }
      case 'attack-swing':
      case 'attack-start':
      case 'death':
      case 'dodge':
      case 'footstep':
      case 'spawn':
        break;
    }
  }

  private onPlayerKill(dead: Fighter): void {
    if (this.killedIds.has(dead.id)) return;
    this.killedIds.add(dead.id);
    this.overlay.hitFeedback('kill');
    this.ui.pushLog({ text: `${dead.name} knocked unconscious`, kind: 'kill' });
    this.cameraCtrl.addShake(0.32 * this.settings.cameraShake);
    this.freeze = Math.max(this.freeze, COMBAT.hitStopKill);
    this.excitement = clamp(this.excitement + 0.22, 0, 1);
    this.arena.cheer(0.7);
    audio.cheer(0.7);

    if (this.mode === 'tournament' && this.tournament) {
      const def = TOURNAMENT.rounds[this.tournament.roundIndex];
      this.ui.pushLog({ text: `You earned ${def.killDenars} denars`, kind: 'reward' });
      this.ui.pushLog({ text: `You got ${def.killXp} experience`, kind: 'xp' });
    } else if (this.melee) {
      this.melee.beaten++;
      this.melee.xpEarned += 8;
      this.ui.pushLog({ text: 'You got 8 experience', kind: 'xp' });
    }
  }

  private onPlayerDeath(): void {
    this.playerDeathHandled = true;
    this.cameraCtrl.setDead();
    this.overlay.setVisible(false);
    this.ui.setTargetOverlay(null);
    this.audioDefeat();
    this.slowMoTimer = 1.6;
    this.ui.pushLog({ text: 'You have been struck down.', kind: 'warning' });
    if (this.mode === 'melee') this.scheduleMeleeEnd(false);
    else this.checkTournamentEnd();
  }

  private audioDefeat(): void {
    audio.play('defeat', { volume: 0.8 });
    audio.setCrowd(0.2);
  }

  /* ---------------------------------------------------------------- */
  /* Round resolution                                                  */
  /* ---------------------------------------------------------------- */

  private checkTournamentEnd(): void {
    const t = this.tournament;
    if (!t || t.matchOver || this.mode !== 'tournament') return;
    const def = TOURNAMENT.rounds[t.roundIndex];
    const aliveTeams = t.teams.filter((team) => team.members.some((m) => {
      const f = this.fighters.find((x) => x.id === m.id);
      return f && f.alive;
    }));
    const playerTeam = t.teams.find((team) => team.isPlayerTeam);
    const playerTeamAlive = !!playerTeam && aliveTeams.includes(playerTeam);
    const playerAlive = !!this.player?.alive;
    const threshold = def.advanceTeams;

    if (!playerTeamAlive) {
      this.scheduleTournamentEnd([], false, false, playerAlive);
      return;
    }
    if (aliveTeams.length <= threshold) {
      const winners = aliveTeams.map((team) => team.id);
      this.scheduleTournamentEnd(winners, true, t.roundIndex === TOURNAMENT.rounds.length - 1, playerAlive);
    }
  }

  private scheduleTournamentEnd(winners: number[], advanced: boolean, champion: boolean, playerAlive: boolean): void {
    const t = this.tournament;
    if (!t || t.pendingEnd) return;
    // Defensive: early rounds need exactly N advancing teams; if simultaneous deaths left too few,
    // promote the next-best houses by remaining fighters / kills so the bracket can continue.
    if (advanced && winners.length < TOURNAMENT.rounds[t.roundIndex].advanceTeams) {
      const ranked = t.teams
        .filter((team) => !winners.includes(team.id))
        .map((team) => ({
          team,
          score: team.members.reduce((acc, m) => {
            const f = this.fighters.find((x) => x.id === m.id);
            return acc + (f?.alive ? 100 : 0) + (f?.kills ?? 0) + (f?.hp ?? 0) * 0.1;
          }, 0),
        }))
        .sort((a, b) => b.score - a.score);
      while (winners.length < TOURNAMENT.rounds[t.roundIndex].advanceTeams && ranked.length) {
        winners.push(ranked.shift()!.team.id);
      }
    }
    t.pendingEnd = { timer: 1.15, winners, advanced, champion };
    t.matchOver = true;
    this.slowMoTimer = Math.max(this.slowMoTimer, 0.7);
    // Disable further fighting.
    for (const f of this.fighters) {
      if (f.alive) {
        f.ai = null;
        f.velocity.set(0, 0, 0);
      }
    }
    if (playerAlive && advanced) {
      const player = this.player;
      if (player) {
        player.playVictory(this.world);
      }
    }
    audio.play(advanced ? 'victory' : 'defeat', { volume: 0.6 });
    if (advanced) {
      audio.cheer(1.0);
      this.arena.cheer(1.0);
    }
    window.setTimeout(() => {
      if (this.tournament === t && this.state === 'fighting') this.finishTournamentRound(winners, advanced, champion);
    }, 1400);
  }

  private finishTournamentRound(winners: number[], advanced: boolean, champion: boolean): void {
    const t = this.tournament;
    if (!t) return;
    const def = TOURNAMENT.rounds[t.roundIndex];
    const player = this.player;
    const stats = this.buildMatchStats();
    const betWon = advanced ? t.bet * TOURNAMENT.betPayout : 0;
    const rewardDenars = advanced
      ? def.purse + stats.kills * def.killDenars + betWon
      : Math.floor(stats.kills * def.killDenars * 0.5);
    const rewardXp = stats.kills * def.killXp + (advanced ? 20 + t.roundIndex * 15 : Math.floor(stats.kills * def.killXp * 0.4));
    const rewardRenown = advanced
      ? (champion ? TOURNAMENT.championRenown : 1 + t.roundIndex)
      : 0;

    grantDenars(this.profile, rewardDenars);
    grantXp(this.profile, rewardXp);
    grantRenown(this.profile, rewardRenown);
    saveProfile(this.profile);
    this.ui.setProfile(this.profile);

    t.stats.kills += stats.kills;
    t.stats.assists += stats.assists;
    t.stats.damageDealt += stats.damageDealt;
    t.stats.damageTaken += stats.damageTaken;
    t.stats.blocks += stats.blocks;
    t.stats.headshots += stats.headshots;
    t.stats.time += stats.time;
    t.totalRewardDenars += rewardDenars;
    t.totalRewardXp += rewardXp;
    t.totalRewardRenown += rewardRenown;
    t.lastReward = { denars: rewardDenars, xp: rewardXp, renown: rewardRenown, bet: t.bet, betWon };
    t.champion = champion && advanced;
    t.eliminated = !advanced;

    // Update survivor roster / kills.
    for (const team of t.teams) {
      const won = winners.includes(team.id);
      for (const member of team.members) {
        const f = this.fighters.find((x) => x.id === member.id);
        if (f) member.kills = f.kills;
        member.alive = won;
      }
    }

    const standings: TournamentMember[] = t.contestants.map((c) => this.memberView(c));
    const nextRoundName = !t.champion && !t.eliminated && t.roundIndex + 1 < TOURNAMENT.rounds.length
      ? TOURNAMENT.rounds[t.roundIndex + 1].name
      : null;
    const result: RoundResultView = {
      victory: advanced,
      advanced,
      playerSurvived: !!player?.alive,
      playerTeamWon: advanced,
      eliminated: t.eliminated,
      champion: t.champion,
      round: t.roundIndex + 1,
      totalRounds: TOURNAMENT.rounds.length,
      roundName: def.name,
      stats,
      rewardDenars,
      rewardXp,
      rewardRenown,
      bet: t.bet,
      betWon,
      purse: def.purse,
      standings,
      nextRoundName,
      playerLevel: this.profile.level,
      playerXp: this.profile.xp,
      playerDenars: this.profile.denars,
      playerRenown: this.profile.renown,
    };
    t.lastResult = result;
    this.state = 'round-result';
    this.pendingContinue = t.champion || t.eliminated ? 'tournament-end' : 'bracket';
    this.ui.hideHUD();
    this.overlay.setVisible(false);
    this.overlay.setHint(null);
    this.overlay.setScoreboard(null);
    this.input.exitLock();
    this.ui.showRoundResult(result);
    audio.setCrowd(0.3);
    this.cameraCtrl.setOrbit(new THREE.Vector3(0, 2, 0), 0);
    if (t.bet > 0) audio.play(betWon > 0 ? 'bet-win' : 'bet-lose', { volume: 0.5 });
    this.ui.setTargetOverlay(null);
    this.targetRingMat.opacity = 0;
  }

  private buildMatchStats(): MatchStatsView {
    const p = this.player;
    const elapsed = this.mode === 'tournament'
      ? this.time - (this.tournament?.roundStart ?? this.time)
      : this.time - (this.melee?.startTime ?? this.time);
    return {
      kills: p?.kills ?? 0,
      assists: this.countAssists(),
      damageDealt: p?.damageDealt ?? 0,
      damageTaken: p?.damageTaken ?? 0,
      blocks: p?.blocks ?? 0,
      headshots: p?.headshots ?? 0,
      time: Math.max(0, elapsed),
    };
  }

  private countAssists(): number {
    return this.playerAssists;
  }

  private scheduleMeleeEnd(victory: boolean): void {
    const m = this.melee;
    if (!m || m.pendingEnd) return;
    m.pendingEnd = { timer: 1.25, victory };
    m.matchOver = true;
    this.slowMoTimer = Math.max(this.slowMoTimer, 0.8);
    for (const f of this.fighters) {
      if (f.alive) {
        f.ai = null;
        f.velocity.set(0, 0, 0);
        if (victory && f.isPlayer) f.playVictory(this.world);
      }
    }
    audio.play(victory ? 'victory' : 'defeat', { volume: 0.7 });
    if (victory) {
      audio.cheer(1.0);
      this.arena.cheer(1.0);
    }
    window.setTimeout(() => {
      if (this.melee === m && this.state === 'fighting') this.finishMelee(victory);
    }, 1500);
  }

  private finishMelee(victory: boolean): void {
    const m = this.melee;
    if (!m) return;
    const stats = this.buildMatchStats();
    const beaten = m.beaten;
    const rewards = meleeReward(beaten, victory || m.defeatedTotal >= m.total);
    const rewardXp = rewards.xp + m.xpEarned;
    grantDenars(this.profile, rewards.denars);
    grantXp(this.profile, rewardXp);
    grantRenown(this.profile, rewards.renown);
    const best = recordMelee(this.profile, beaten);
    saveProfile(this.profile);
    this.ui.setProfile(this.profile);

    const result: MeleeResultView = {
      victory,
      beaten,
      total: m.total,
      stats,
      rewardDenars: rewards.denars,
      rewardXp,
      rewardRenown: rewards.renown,
      best,
      playerLevel: this.profile.level,
      playerXp: this.profile.xp,
      playerDenars: this.profile.denars,
      playerRenown: this.profile.renown,
    };
    m.lastResult = result;
    this.state = 'melee-result';
    this.pendingContinue = 'tournament-end';
    this.ui.hideHUD();
    this.overlay.setVisible(false);
    this.overlay.setHint(null);
    this.overlay.setScoreboard(null);
    this.ui.showMeleeResult(result);
    audio.setCrowd(0.25);
    this.input.exitLock();
    this.targetRingMat.opacity = 0;
  }

  /* ---------------------------------------------------------------- */
  /* Continue / menus                                                  */
  /* ---------------------------------------------------------------- */

  continueAfterResult(): void {
    if (this.state === 'round-result' && this.tournament) {
      const t = this.tournament;
      if (this.pendingContinue === 'tournament-end') {
        this.showTournamentEnd();
        return;
      }
      t.roundIndex++;
      if (t.roundIndex >= TOURNAMENT.rounds.length) {
        this.showTournamentEnd();
        return;
      }
      this.cleanupFighters();
      this.setupRoundTeams(t.roundIndex);
      this.ui.hideHUD();
      this.showBracket();
      this.cameraCtrl.setOrbit(new THREE.Vector3(0, 2.2, -3), 0.6);
      audio.startMusic('tournament');
      return;
    }
    if (this.state === 'tournament-end' || this.state === 'melee-result') {
      this.quitToMenu();
    }
  }

  private showTournamentEnd(): void {
    const t = this.tournament;
    if (!t) return;
    recordTournament(this.profile, t.champion);
    saveProfile(this.profile);
    this.ui.setProfile(this.profile);
    this.state = 'tournament-end';
    const last = t.lastResult;
    const view: TournamentEndView = {
      champion: t.champion,
      eliminated: t.eliminated,
      round: (last?.round ?? t.roundIndex + 1),
      totalRounds: TOURNAMENT.rounds.length,
      stats: {
        kills: t.stats.kills,
        assists: t.stats.assists,
        damageDealt: t.stats.damageDealt,
        damageTaken: t.stats.damageTaken,
        blocks: t.stats.blocks,
        headshots: t.stats.headshots,
        time: t.stats.time,
      },
      rewardDenars: t.totalRewardDenars,
      rewardXp: t.totalRewardXp,
      rewardRenown: t.totalRewardRenown,
      purse: last?.purse ?? 0,
      bet: last?.bet ?? 0,
      betWon: last?.betWon ?? 0,
      standings: t.contestants.map((c) => this.memberView(c)),
      playerLevel: this.profile.level,
      playerXp: this.profile.xp,
      playerDenars: this.profile.denars,
      playerRenown: this.profile.renown,
      tournamentsWon: this.profile.tournamentsWon,
      playerName: this.profile.name,
    };
    this.ui.hideHUD();
    this.overlay.setHint(null);
    this.ui.showTournamentEnd(view);
    audio.startMusic(t.champion ? 'victory' : 'defeat');
    this.input.exitLock();
    this.cameraCtrl.setOrbit(new THREE.Vector3(0, 2.2, 0), 0);
    this.overlay.setVisible(false);
    this.targetRingMat.opacity = 0;
  }

  quitToMenu(): void {
    this.autoStarted = false;
    this.tournament = null;
    this.melee = null;
    this.cleanupFighters();
    this.loadoutPicker.hide();
    this.ui.hideBracket();
    this.ui.hideControls();
    this.ui.hideSettings();
    this.ui.hideHUD();
    this.ui.setTargetOverlay(null);
    this.showMenu();
    this.input.exitLock();
  }

  restart(): void {
    if (this.mode === 'melee') this.startMelee();
    else this.startTournament();
  }

  pause(): void {
    if (this.state !== 'fighting' && this.state !== 'intro') return;
    this.previousState = this.state;
    this.state = 'paused';
    this.overlay.setVisible(false);
    this.overlay.setHint(null);
    this.overlay.setScoreboard(null);
    this.ui.setTargetOverlay(null);
    this.ui.showPause();
    audio.setCrowd(0.1);
    this.input.exitLock();
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.state = this.previousState === 'intro' ? 'intro' : 'fighting';
    this.ui.hidePause();
    this.overlay.setVisible(true);
    this.input.requestLock();
  }

  openSettings(): void {
    this.ui.showSettings();
  }

  openControls(): void {
    this.ui.showControls();
  }

  closeOverlay(): void {
    if (this.state === 'paused') this.ui.showPause();
    else if (this.state === 'menu') this.ui.showMainMenu(this.profile);
    else this.ui.hideControls();
  }

  applySettings(settings: Settings, persist = true): void {
    this.settings = { ...settings };
    if (persist) {
      try {
        localStorage.setItem('blade-and-mount.settings.v1', JSON.stringify(this.settings));
      } catch { /* ignore */ }
    }
    this.engine.setQuality(this.settings.quality);
    this.cameraCtrl.applySettings(this.settings);
    audio.setVolumes(this.settings.masterVolume, this.settings.musicVolume, this.settings.sfxVolume);
    this.ui.updateSettings(this.settings);
    this.overlay.setVisible(this.state === 'fighting');
  }

  toggleLanguage(): void {
    this.applySettings({ ...this.settings, language: this.settings.language === 'vi' ? 'en' : 'vi' });
  }

  /* ---------------------------------------------------------------- */
  /* HUD                                                               */
  /* ---------------------------------------------------------------- */

  private updateHud(): void {
    const player = this.player;
    if (!player) return;
    const t = this.tournament;
    const m = this.melee;
    const def = t ? TOURNAMENT.rounds[t.roundIndex] : null;
    const roundLabel = t ? `Round ${t.roundIndex + 1} of ${TOURNAMENT.rounds.length}` : 'Arena Melee';
    const objective = t
      ? def!.objective
      : `${(m?.total ?? 35) - (m?.defeatedTotal ?? 0)} fighters remain in the yard`;
    const target = player.alive
      ? this.playerCtrl.getTargetView(
        this.fighters,
        player,
        this.engine.camera,
        (teamId) => this.teamColorOf(teamId),
      )
      : null;
    const hud: HudState = {
      mode: this.mode,
      opponentsBeaten: m?.beaten ?? 0,
      opponentsRemaining: m ? m.total - m.defeatedTotal : 0,
      opponentsTotal: m?.total ?? 0,
      health: player.hp,
      maxHealth: player.maxHp,
      stamina: player.stamina,
      maxStamina: player.maxStamina,
      roundLabel,
      roundIndex: t ? t.roundIndex : 0,
      roundTotal: t ? TOURNAMENT.rounds.length : 1,
      objective,
      teams: t ? this.teamViews() : [],
      playerAlive: player.alive,
      target,
      hint: this.fightingHint(player),
      denars: this.profile.denars,
      bet: t?.bet ?? 0,
      paused: false,
    };
    this.ui.updateHud(hud);
    this.ui.setTargetOverlay(target);
    this.overlay.setHint(this.input.locked ? null : 'Click the sand to capture the mouse');
  }

  private updateHudTargetOnly(): void {
    if (this.player) this.ui.setTargetOverlay(null);
  }

  private fightingHint(player: Fighter): string | null {
    if (!player.alive) return 'You are down — the fight continues without you.';
    if (player.hp < player.maxHp * 0.3) return 'Low health — guard, dodge, and look for an opening.';
    if (this.mode === 'tournament' && this.tournament?.roundIndex === 0) {
      return this.time - (this.tournament.roundStart || this.time) < 14
        ? 'Hold LMB to choose a direction, release to strike. Hold RMB to guard the matching direction.'
        : null;
    }
    return null;
  }

  private teamViews(): TournamentTeam[] {
    const t = this.tournament;
    if (!t) return [];
    return t.teams.map((team) => {
      let alive = 0;
      const members: TournamentMember[] = team.members.map((member) => {
        const f = this.fighters.find((x) => x.id === member.id);
        if (f?.alive) alive++;
        return this.memberView(member, f);
      });
      return {
        id: team.id,
        name: team.name,
        color: `#${team.color.toString(16).padStart(6, '0')}`,
        colorName: team.colorName,
        members,
        alive,
        isPlayerTeam: team.isPlayerTeam,
      };
    });
  }

  private memberView(member: Contestant, fighter?: Fighter): TournamentMember {
    return {
      id: member.id,
      name: member.name,
      isPlayer: member.isPlayer,
      alive: fighter ? fighter.alive : member.alive,
      kills: fighter ? fighter.kills : member.kills,
      hp: fighter?.hp ?? 0,
      maxHp: fighter?.maxHp ?? 100,
    };
  }

  private teamColorOf(teamId: number): string {
    const palette = TEAM_PALETTE.find((p) => p.id === teamId);
    return palette?.css ?? '#d8c9a8';
  }

  /* ---------------------------------------------------------------- */
  /* Cleanup / dispose                                                 */
  /* ---------------------------------------------------------------- */

  private cleanupFighters(): void {
    for (const f of this.fighters) {
      f.ai?.dispose?.();
      f.dispose();
    }
    this.fighters = [];
    this.player = null;
    this.playerDeathHandled = false;
    this.playerCtrl.reset();
    this.fadeMap.clear();
    this.effects.clearDecals();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cleanupFighters();
    this.targetRing.geometry.dispose();
    this.targetRingMat.dispose();
    this.engine.scene.remove(this.targetRing);
    this.effects.dispose();
    this.arena.dispose();
    this.overlay.dispose();
    this.loadoutPicker.dispose();
    for (const fn of this.disposeFns) fn();
    this.input.dispose();
  }

  /** Expose debug info for QA + screenshots. */
  getDebugState(): Record<string, unknown> {
    return {
      state: this.state,
      mode: this.mode,
      fighters: this.fighters.length,
      alive: this.fighters.filter((f) => f.alive).length,
      playerHp: this.player?.hp ?? 0,
      tournamentRound: this.tournament ? this.tournament.roundIndex + 1 : 0,
      teams: this.tournament?.teams.length ?? 0,
      meleeBeaten: this.melee?.beaten ?? 0,
      meleeTotal: this.melee?.total ?? 0,
      locked: this.input.locked,
      seed: this.tournament?.seed ?? this.melee?.seed ?? 0,
      fps: Math.round(this.lastFrameStats.fps),
      drawCalls: this.engine.renderer.info.render.calls,
      triangles: this.engine.renderer.info.render.triangles,
    };
  }

  /* Debug helpers used by tools/shot.mjs and QA. */
  debugStartTournament = (): void => { this.startTournament(); };
  debugStartMelee = (): void => { this.startMelee(); };
  debugEnterRound = (): void => { this.enterRound(); };
  debugSelectLoadout = (index = 0): void => {
    if (this.state !== 'loadout') return;
    const choice = this.pendingLoadoutChoices[index] ?? this.pendingLoadoutChoices[0];
    if (choice) this.confirmLoadout(choice.loadout);
  };
  debugContinue = (): void => { this.continueAfterResult(); };
  debugPause = (): void => { this.pause(); };
  debugResume = (): void => { this.resume(); };
  debugSetPlayerGod = (): void => {
    if (this.player) { this.player.hp = 9999; this.player.maxHp = 9999; }
  };
  debugKillEnemies = (): void => {
    for (const f of this.fighters) {
      if (!f.isPlayer && f.alive) f.knockOut(this.world);
    }
  };
}

