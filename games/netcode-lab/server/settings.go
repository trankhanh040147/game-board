package server

import (
	"encoding/json"

	"fmt"
	"netcodelab/net/cond"
	"slices"
)

// Settings are server-wide and broadcast to every client (B.7). Client-side
// toggles (predict, reconcile, interp, fps cap) live here too, so the whole
// room sees the same mode.
type Settings struct {
	Authority  string  `json:"authority"` // "server" | "trust"
	Predict    bool    `json:"predict"`
	Reconcile  bool    `json:"reconcile"`
	Interp     bool    `json:"interp"`
	InterpMs   int     `json:"interpMs"`
	InterpAuto bool    `json:"interpAuto"`
	InterpK    float64 `json:"interpK"`
	LagComp    bool    `json:"lagcomp"`
	HistoryMs  int     `json:"historyMs"`
	TickRate   int     `json:"tickRate"`
	SendRate   int     `json:"sendRate"`
	FPSCap     int     `json:"fpsCap"` // 0 = uncapped
	TruthGhost bool    `json:"truthGhost"`
	Transport  string  `json:"transport"` // "ws" | "wt": preferred transport for clients
	// FavorVictimRttMs: when > 0 and the shooter's RTT is above it, the server
	// does not rewind for that shooter (A.10 mitigation, P24).
	FavorVictimRttMs int `json:"favorVictimRttMs"`
	// SpeedScale is a server-only movement modifier (P25 rubber-band, B.9
	// check 2): the client does not know it, so predictions are corrected.
	SpeedScale float64 `json:"speedScale"`
	// Loop selects the server loop (P19): "zeroalloc" reuses buffers,
	// "naive" allocates per tick/client/entity. Same bytes on the wire.
	Loop string `json:"loop"`
	// GoMemLimitMB sets runtime/debug.SetMemoryLimit (0 = no limit).
	GoMemLimitMB int `json:"goMemLimitMB"`
}

// DefaultSettings match A.1 / B.4.
func DefaultSettings() Settings {
	return Settings{
		Authority: "server", Predict: true, Reconcile: true, Interp: true,
		InterpMs: 100, InterpAuto: true, InterpK: 2,
		LagComp: true, HistoryMs: 1000,
		TickRate: 64, SendRate: 20, FPSCap: 60,
		Transport: "wt", SpeedScale: 1, Loop: "zeroalloc",
	}
}

var (
	allowedTick = []int{20, 30, 64, 128}
	allowedSend = []int{10, 20, 30, 64, 128}
	allowedFPS  = []int{0, 30, 60, 144}
)

// SettingInfo describes one key for the Lab panel.
type SettingInfo struct {
	Key     string `json:"key"`
	Kind    string `json:"kind"` // bool | int | float | enum
	Allowed any    `json:"allowed,omitempty"`
	Min     any    `json:"min,omitempty"`
	Max     any    `json:"max,omitempty"`
	// Built is false while the server-side half of the feature does not exist
	// yet; the setting is stored and broadcast but has no server effect.
	Built bool   `json:"built"`
	Note  string `json:"note,omitempty"`
}

func SupportedSettings() []SettingInfo {
	return []SettingInfo{
		{Key: "authority", Kind: "enum", Allowed: []string{"server", "trust"}, Built: true, Note: "trust: the server relays client claims (type 7) instead of simulating (A.5)"},
		{Key: "predict", Kind: "bool", Built: true, Note: "client-side, WASM Predictor"},
		{Key: "reconcile", Kind: "bool", Built: true, Note: "client-side, WASM Predictor.reconcile"},
		{Key: "interp", Kind: "bool", Built: true, Note: "client-side render of other players"},
		{Key: "interpMs", Kind: "int", Min: 0, Max: 250, Built: true, Note: "client-side"},
		{Key: "interpAuto", Kind: "bool", Built: true, Note: "client-side: buffer = interpK x send interval"},
		{Key: "interpK", Kind: "float", Min: 0.5, Max: 5, Built: true, Note: "client-side"},
		{Key: "lagcomp", Kind: "bool", Built: true, Note: "server rewinds other players to the shooter's render time"},
		{Key: "historyMs", Kind: "int", Min: 0, Max: 1000, Built: true, Note: "lag-comp rewind cap"},
		{Key: "favorVictimRttMs", Kind: "int", Min: 0, Max: 300, Built: true, Note: "0 = off; no rewind for shooters above this RTT (P24)"},
		{Key: "loop", Kind: "enum", Allowed: []string{"zeroalloc", "naive"}, Built: true, Note: "P19: allocating vs zero-alloc server loop, same bytes on the wire"},
		{Key: "goMemLimitMB", Kind: "int", Min: 0, Max: 65536, Built: true, Note: "GOMEMLIMIT via runtime/debug.SetMemoryLimit; 0 = no limit"},
		{Key: "speedScale", Kind: "float", Min: 0.25, Max: 2, Built: true, Note: "server-only movement modifier, not known to clients (rubber-band, P25)"},
		{Key: "tickRate", Kind: "enum", Allowed: allowedTick, Built: true},
		{Key: "sendRate", Kind: "enum", Allowed: allowedSend, Built: true, Note: "must be <= tickRate"},
		{Key: "fpsCap", Kind: "enum", Allowed: allowedFPS, Built: true, Note: "client-side, 0 = uncapped"},
		{Key: "truthGhost", Kind: "bool", Built: true, Note: "server sends the debug feed (type 6) while on"},
		{Key: "transport", Kind: "enum", Allowed: []string{"ws", "wt"}, Built: true, Note: "clients reconnect with this transport"},
	}
}

// Validate checks every field against B.4.
func (s Settings) Validate() error {
	if s.Authority != "server" && s.Authority != "trust" {
		return fmt.Errorf("authority %q (server | trust)", s.Authority)
	}
	if s.FavorVictimRttMs < 0 || s.FavorVictimRttMs > 300 {
		return fmt.Errorf("favorVictimRttMs out of range")
	}
	if s.Loop != "zeroalloc" && s.Loop != "naive" {
		return fmt.Errorf("loop %q (zeroalloc | naive)", s.Loop)
	}
	if s.GoMemLimitMB < 0 || s.GoMemLimitMB > 65536 {
		return fmt.Errorf("goMemLimitMB out of range 0..65536")
	}
	if s.SpeedScale < 0.25 || s.SpeedScale > 2 {
		return fmt.Errorf("speedScale out of range 0.25..2")
	}
	if !slices.Contains(allowedTick, s.TickRate) {
		return fmt.Errorf("tickRate %d not in %v", s.TickRate, allowedTick)
	}
	if !slices.Contains(allowedSend, s.SendRate) || s.SendRate > s.TickRate {
		return fmt.Errorf("sendRate %d not in %v or above tickRate", s.SendRate, allowedSend)
	}
	if !slices.Contains(allowedFPS, s.FPSCap) {
		return fmt.Errorf("fpsCap %d not in %v", s.FPSCap, allowedFPS)
	}
	if s.InterpMs < 0 || s.InterpMs > 250 || s.InterpK < 0.5 || s.InterpK > 5 {
		return fmt.Errorf("interp out of range")
	}
	if s.HistoryMs < 0 || s.HistoryMs > 1000 {
		return fmt.Errorf("historyMs out of range")
	}
	if s.Transport != "ws" && s.Transport != "wt" {
		return fmt.Errorf("transport %q", s.Transport)
	}
	return nil
}

// Merge applies a partial JSON object on top of s; unknown keys are an error.
func (s Settings) Merge(patch json.RawMessage) (Settings, error) {
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(patch, &keys); err != nil {
		return s, err
	}
	known := map[string]bool{}
	for _, k := range SupportedSettings() {
		known[k.Key] = true
	}
	for k := range keys {
		if !known[k] {
			return s, fmt.Errorf("unknown setting %q", k)
		}
	}
	out := s
	if err := json.Unmarshal(patch, &out); err != nil {
		return s, err
	}
	return out, out.Validate()
}

// Preset is a one-click Lab configuration (B.6).
type Preset struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Section string `json:"section"` // Part A section, for the banner link to CONCEPTS.md
	Banner  string `json:"banner"`
	Built   bool   `json:"built"`
	apply   func(*Settings)
	// cond, when set, is applied to every client and becomes the default for
	// new joins. Presets without it restore DefaultCond, so each preset sets
	// the whole demo state in one click.
	cond func() CondPair
}

func base(s *Settings) { *s = DefaultSettings() }

// Presets lists every B.6 preset. Built=false ones are listed so the Lab panel
// can show them as "not built yet"; applying them is refused.
func Presets() []Preset {
	return []Preset{
		{ID: "P01", Title: "Vocabulary", Section: "A.1", Built: true, apply: base,
			Banner: "RTT, tick, snapshot and frame. Defaults are the A.1 running assumptions (est.): 64 Hz server, 20 snapshots/s, 60 FPS; 40 ms RTT is simulated by the conditioner."},
		{ID: "P02", Title: "Dumb client", Section: "A.4", Built: true,
			apply: func(s *Settings) {
				base(s)
				s.Predict, s.Reconcile, s.Interp = false, false, false
			},
			Banner: "The client only draws what the server sends: correct, cheat-proof, and you move one RTT plus waits late."},
		{ID: "P03", Title: "Trust the client", Section: "A.5", Built: true,
			apply: func(s *Settings) {
				base(s)
				s.Authority = "trust"
			},
			Banner: "The client reports its own position and hits; the server relays. Instant and fair for honest players, and a modded client can headshot through walls."},
		{ID: "P04", Title: "Prediction", Section: "A.6", Built: true,
			apply: func(s *Settings) {
				base(s)
				s.Reconcile = false
			},
			Banner: "Your own movement runs locally at once; without reconciliation each snapshot snaps you back to the past."},
		{ID: "P05", Title: "Reconciliation", Section: "A.7", Built: true, apply: base,
			Banner: "Unacknowledged inputs are replayed on top of the server state: same rules, so nothing moves."},
		{ID: "P06", Title: "Raw snapshots", Section: "A.8", Built: true,
			apply: func(s *Settings) {
				base(s)
				s.Interp = false
			},
			cond: func() CondPair {
				c := DefaultCond()
				c.Down.JitterMs = 15
				return c
			},
			Banner: "Other players are drawn at the latest snapshot: they stand still, then jump every 50 ms, more under jitter."},
		{ID: "P07", Title: "Interpolation", Section: "A.9", Built: true,
			apply: func(s *Settings) {
				base(s)
				s.Interp, s.InterpAuto, s.InterpK, s.TruthGhost = true, true, 2, true
			},
			Banner: "Others are drawn about 100 ms in the past, gliding between two snapshots; the ghost is the server's present."},
		{ID: "P08", Title: "Three truths", Section: "A.10", Built: true,
			apply: func(s *Settings) {
				base(s)
				s.LagComp, s.TruthGhost = false, true
			},
			Banner: "Shooter, server and target see three different moments; without rewind the server checks the target's present and you miss what you aimed at."},
		{ID: "P09", Title: "Lag compensation", Section: "A.10", Built: true,
			apply: func(s *Settings) {
				base(s)
				s.LagComp, s.TruthGhost = true, true
			},
			Banner: "The server rewinds other players to what you were seeing (red = your view, blue = rewound server hitbox) and traces there."},
		{ID: "P10", Title: "Scorecard", Section: "A.2", Built: true, apply: base,
			Banner: "Prediction + reconciliation, interpolation, lag compensation and server authority: all four goals green."},
		{ID: "P11", Title: "Shot budget", Section: "A.11"},
		{ID: "P12", Title: "Send and tick rate", Section: "A.11", Built: true,
			apply: func(s *Settings) {
				base(s)
				s.SendRate = 64
			},
			Banner: "Snapshots at 64/s: the interpolation buffer and snapshot wait shrink (formula ~103 ms, est.), and server bytes/s rise roughly linearly."},
		{ID: "P13", Title: "Client FPS", Section: "A.11", Built: true,
			apply: func(s *Settings) {
				base(s)
				s.TickRate, s.SendRate, s.FPSCap = 128, 128, 144
			},
			Banner: "128 Hz ticks and snapshots plus 144 FPS clients: both frame waits shrink too (formula ~71 ms, est.)."},
		{ID: "P14", Title: "Peeker's advantage", Section: "A.11"},
		{ID: "P15", Title: "Budget table", Section: "A.11"},
		{ID: "P16", Title: "Regions and fragile cables", Section: "A.12"},
		{ID: "P17", Title: "Beacons and matchmaking", Section: "A.12"},
		{ID: "P18", Title: "Relay / backbone", Section: "A.12"},
		{ID: "P19", Title: "Tick health", Section: "A.12"},
		{ID: "P20", Title: "Percentiles", Section: "A.12"},
		{ID: "P21", Title: "Rollback", Section: "A.13"},
		{ID: "P22", Title: "Input delay", Section: "A.13"},
		{ID: "P23", Title: "Lockstep", Section: "A.13"},
		{ID: "P24", Title: "Died behind the wall", Section: "A.10", Built: true,
			apply: func(s *Settings) {
				base(s)
				s.LagComp, s.HistoryMs, s.TruthGhost = true, 1000, true
			},
			cond: func() CondPair {
				return CondPair{Up: condDelay(50), Down: condDelay(50)}
			},
			Banner: "Rewind is fair to the shooter, so the target can die after reaching cover on its own screen. RTT is raised to 100 ms (simulated) to make it visible."},
		{ID: "P25", Title: "Glitch lab", Section: "A.14"},
		{ID: "P26", Title: "Sub-tick", Section: "A.15"},
		{ID: "P27", Title: "Compression", Section: "A.15"},
		{ID: "P28", Title: "Interest management", Section: "A.15"},
		{ID: "P29", Title: "Transport", Section: "A.15"},
	}
}

func condDelay(ms float64) cond.Params { return cond.Params{DelayMs: ms} }
