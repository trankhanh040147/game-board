// M3/M4 game data as defined by core: docs/PROTOCOL.md v2 and wasm/main.go decodeEvent (apiVersion 2).
// Positions are Q16.16 integer triples [x, y, z]; divide by NetcodeSim.FX for metres.

export type Fx3 = [number, number, number];
export interface Vec3 { x: number; y: number; z: number } // metres

/** Snapshot event to the shooter: verdict on one fire input (P08 reason, P09 boxes, P11 stamps). */
export interface ShotEvent {
  type: "shot"; shotSeq: number; resolveTick: number; renderTick: number; renderFrac: number; rewoundTick: number; rewoundFrac: number;
  flags: number; lagcomp: boolean; clamped: boolean; favoured: boolean; killed: boolean; trust: boolean;
  hitId: number; hitbox: number; damage: number; victimHp: number;
  seenId: number; seenHitbox: number; movedCm: number; seenPos: Fx3; usedPos: Fx3; wallDistM: number; recvMs: number; tickStartMs: number;
  subtickFrac: number; timingErrMs: number;
}
/** Snapshot event to the victim. */
export interface DamageEvent { type: "damage"; shotSeq: number; shooterId: number; hitbox: number; damage: number; health: number; resolveTick: number; flags: number; killed: boolean }
/** Snapshot event to the victim on death (P24 replay). */
export interface DeathEvent {
  type: "death"; life: number; shooterId: number; hitbox: number; flags: number; lagcomp: boolean; shotSeq: number; resolveTick: number;
  rewoundTick: number; rewoundFrac: number; hitPos: Fx3; nowPos: Fx3; shooterPos: Fx3; shooterYaw: number; shooterPitch: number; respawnTick: number;
}
export type SnapEvent = ShotEvent | DamageEvent | DeathEvent | { type: "unknown"; code: number };

/** Control channel. */
export interface RoundMsg { t: "round"; no: number; state: "playing" | "ended"; endsAtServerMs: number; scores: { blue: number; orange: number } }
export interface KillMsg { t: "kill"; killerId: number; killer: string; victimId: number; victim: string; headshot: boolean; tick: number; trust: boolean; lagcomp: boolean }
export interface ClaimRejectedMsg { t: "claimRejected"; id: number; name: string; victimId: number; hitbox: number; tick: number; reason: string }
export interface ScoreRow {
  id: number; name: string; team: "blue" | "orange"; kills: number | null; deaths: number | null; alive?: boolean;
  pingMs: number | null; pingSource?: "client" | "server-acks"; lossPct: number | null; fps: number | null;
  shots?: number; hits?: number; rejectedClaims?: number;
}
export interface HistoryMsg { t: "history"; tickRate: number; ticks: { tick: number; serverTimeMs: number; players: { id: number; team: string; x: number; y: number; z: number; yaw: number; pitch: number; alive: boolean }[] }[] }
/** What each client relays to spectators while truthGhost is on (shape chosen by the client; the server forwards it). */
export interface DebugPosData { tick: number; serverMs: number; own: Vec3; others: { id: number; x: number; y: number; z: number }[] }

export const HIT_HEAD = 2;
export const toVec = (p: Fx3, FX: number): Vec3 => ({ x: p[0] / FX, y: p[1] / FX, z: p[2] / FX });
