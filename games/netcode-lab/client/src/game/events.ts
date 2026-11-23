// M3/M4 game events as the client consumes them. PROPOSAL sent to core (2026-11-23); the WASM `decode` is expected to
// turn snapshot events into these objects (field `kind`), and the control channel to carry `round` and `scoreboard`.
// Until core confirms them in docs/PROTOCOL.md nothing produces these, so the HUD that uses them stays empty.

export interface Vec3 { x: number; y: number; z: number } // metres (WASM converts from Q16.16)

/** Server-confirmed hit. Sent to the shooter (hit marker, damage number) and to the victim (damage taken). */
export interface HitEvent { kind: "hit"; shooter: number; victim: number; damage: number; headshot: boolean; shotSeq: number; serverTick: number; health: number }
/** Broadcast to everyone (kill feed). */
export interface KillEvent { kind: "kill"; killer: number; victim: number; headshot: boolean; serverTick: number }
/** To the shooter for every resolved shot: why it hit or missed (P08), and the rewind data for the P09 overlay. */
export interface ShotEvent {
  kind: "shot"; shotSeq: number; hit: boolean; victim: number | null; headshot: boolean;
  lagcomp: boolean;            // was the rewind applied
  renderTick: number;          // what the client said it saw (tick + frac/65536)
  rewoundTick: number;         // tick the server traced against after clamping to the history cap
  clamped: boolean;            // rewind was limited by historyMs
  nearest: number | null;      // the player the ray passed closest to (for the miss reason)
  seenPos: Vec3 | null;        // server history: nearest player's position at rewoundTick (blue box, P09)
  nowPos: Vec3 | null;         // server: nearest player's position when the shot was resolved (P08 "moved N cm")
}
/** P03: a result claim from a client the server refused (authoritative modes). */
export interface RejectedEvent { kind: "rejected"; claimant: number; victim: number; reason: string }
/** P24: to the victim on death, so it can replay why it died. */
export interface DeathEvent { kind: "death"; killer: number; hitTick: number; rewoundTick: number; victimAtHit: Vec3; victimAtRewound: Vec3; shooterRttMs: number; shooterInterpMs: number; respawnAtServerMs: number }

export type GameEvent = HitEvent | KillEvent | ShotEvent | RejectedEvent | DeathEvent;

/** Control channel (JSON). */
export interface RoundMsg { t: "round"; round: number; phase: "live" | "intermission"; endsAtServerMs: number; score: { blue: number; orange: number }; winner?: "blue" | "orange" | "draw" }
export interface ScoreRow { id: number; name: string; team: "blue" | "orange"; kills: number | null; deaths: number | null; pingMs: number | null; lossPct: number | null; fps: number | null }
export interface ScoreboardMsg { t: "scoreboard"; players: ScoreRow[] }

export function isGameEvent(e: unknown): e is GameEvent {
  return !!e && typeof e === "object" && typeof (e as { kind?: unknown }).kind === "string";
}
