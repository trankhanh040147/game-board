// A.2 scorecard computed from the active modes (P10). Inputs are the settings the server broadcasts.

export interface ModeState {
  mode: "dumb" | "auth" | "trust"; // auth = authoritative server with optional client techniques
  predict: boolean; reconcile: boolean; interp: boolean; lagcomp: boolean;
}
export type Cell = "yes" | "partial" | "no";
export interface Score { instant: Cell; smooth: Cell; fair: Cell; cheatProof: Cell; why: Record<string, string> }

export function score(m: ModeState): Score {
  const why: Record<string, string> = {};
  let instant: Cell, fair: Cell;
  if (m.mode === "trust") { instant = "yes"; why.instant = "client simulates itself"; }
  else if (m.mode === "dumb" || !m.predict) { instant = "no"; why.instant = "waits for the server (no prediction)"; }
  else if (!m.reconcile) { instant = "partial"; why.instant = "predicted, but snaps back without reconciliation"; }
  else { instant = "yes"; why.instant = "prediction + reconciliation"; }
  const smooth: Cell = m.interp ? "yes" : "no";
  why.smooth = m.interp ? "interpolation" : "others drawn at raw snapshots";
  if (m.mode === "trust") { fair = "yes"; why.fair = "client claims its own hits"; }
  else { fair = m.lagcomp ? "yes" : "no"; why.fair = m.lagcomp ? "lag compensation" : "server checks the current position"; }
  const cheatProof: Cell = m.mode === "trust" ? "no" : "yes";
  why.cheatProof = m.mode === "trust" ? "server relays client claims" : "server authority";
  return { instant, smooth, fair, cheatProof, why };
}
