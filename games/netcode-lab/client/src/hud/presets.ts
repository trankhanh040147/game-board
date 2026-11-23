// Catalogue of HANDOFF B.6. Which presets work is decided by the server (it advertises them); the client never assumes.

export interface PresetInfo { id: string; group: string; idea: string; section: string }

/** docs/presets.json (scribe): banner sentence, observe criterion and CONCEPTS anchor per preset. */
export interface PresetDoc { id: string; group: string; idea: string; observe: string; banner: string; concept: string }
const found = import.meta.glob<PresetDoc[]>("../../../docs/presets.json", { eager: true, import: "default" });
export const PRESET_DOCS = new Map<string, PresetDoc>((Object.values(found)[0] ?? []).map((p) => [p.id, p]));
export const conceptUrl = (anchor: string) => `./concepts.html#${anchor}`;

export const PRESETS: PresetInfo[] = [
  { id: "P01", group: "Core netcode", idea: "Vocabulary", section: "A.1" },
  { id: "P02", group: "Core netcode", idea: "Dumb client", section: "A.4" },
  { id: "P03", group: "Core netcode", idea: "Trust client", section: "A.5" },
  { id: "P04", group: "Core netcode", idea: "Prediction", section: "A.6" },
  { id: "P05", group: "Core netcode", idea: "Reconciliation", section: "A.7" },
  { id: "P06", group: "Core netcode", idea: "Raw snapshots", section: "A.8" },
  { id: "P07", group: "Core netcode", idea: "Interpolation", section: "A.9" },
  { id: "P08", group: "Core netcode", idea: "Three truths", section: "A.10" },
  { id: "P09", group: "Core netcode", idea: "Lag compensation", section: "A.10" },
  { id: "P10", group: "Core netcode", idea: "Scorecard", section: "A.2" },
  { id: "P11", group: "Latency budget", idea: "Shot budget", section: "A.11" },
  { id: "P12", group: "Latency budget", idea: "Send and tick rate", section: "A.11" },
  { id: "P13", group: "Latency budget", idea: "Client FPS", section: "A.11" },
  { id: "P14", group: "Latency budget", idea: "Peeker's advantage", section: "A.10" },
  { id: "P15", group: "Latency budget", idea: "Budget table", section: "A.11" },
  { id: "P16", group: "Infrastructure", idea: "Regions and cables", section: "A.12" },
  { id: "P17", group: "Infrastructure", idea: "Beacons and matchmaking", section: "A.12" },
  { id: "P18", group: "Infrastructure", idea: "Relay / backbone", section: "A.12" },
  { id: "P19", group: "Infrastructure", idea: "Tick health", section: "A.12" },
  { id: "P20", group: "Infrastructure", idea: "Percentiles", section: "A.12" },
  { id: "P21", group: "Other genres (duel)", idea: "Rollback", section: "A.13" },
  { id: "P22", group: "Other genres (duel)", idea: "Input delay", section: "A.13" },
  { id: "P23", group: "Other genres (duel)", idea: "Lockstep", section: "A.13" },
  { id: "P24", group: "Edge cases", idea: "Died behind the wall", section: "A.10" },
  { id: "P25", group: "Edge cases", idea: "Glitch lab", section: "A.14" },
  { id: "P26", group: "Edge cases", idea: "Sub-tick", section: "A.15" },
  { id: "P27", group: "Edge cases", idea: "Compression", section: "A.15" },
  { id: "P28", group: "Edge cases", idea: "Interest management", section: "A.15" },
  { id: "P29", group: "Edge cases", idea: "Transport", section: "A.15" },
];
