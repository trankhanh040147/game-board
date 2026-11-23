package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"netcodelab/net/codec"
	"netcodelab/net/transport"
	"netcodelab/sim"
)

func newTestServer(t *testing.T) (*Room, string) {
	room := NewRoom(slog.New(slog.NewTextHandler(io.Discard, nil)), "secret")
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go room.Run(ctx)
	srv := httptest.NewServer(transport.WSHandler(room.HandleConn))
	t.Cleanup(srv.Close)
	return room, "ws" + strings.TrimPrefix(srv.URL, "http")
}

func ctrl(t *testing.T, c transport.Conn, v any) {
	b, _ := json.Marshal(v)
	if err := c.SendControl(b); err != nil {
		t.Fatal(err)
	}
}

// next returns the next control message of type typ, skipping others.
func next(t *testing.T, c transport.Conn, typ string) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		m, err := c.Recv(ctx)
		if err != nil {
			t.Fatalf("waiting for %q: %v", typ, err)
		}
		if !m.Control {
			continue
		}
		var v map[string]any
		json.Unmarshal(m.Data, &v)
		if v["t"] == typ {
			return v
		}
	}
}

func TestControlProtocol(t *testing.T) {
	_, url := newTestServer(t)
	c, err := transport.DialWS(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close("")
	ctrl(t, c, map[string]any{"t": "join", "name": "tester"})
	w := next(t, c, "welcome")
	if w["id"].(float64) != 1 || w["team"] != "blue" || w["presets"] == nil || w["supportedSettings"] == nil {
		t.Fatalf("welcome %v", w)
	}
	set := w["settings"].(map[string]any)
	if set["tickRate"].(float64) != 64 || set["sendRate"].(float64) != 20 || set["predict"] != true {
		t.Fatalf("defaults %v", set)
	}
	cnd := w["cond"].(map[string]any)["up"].(map[string]any)
	if cnd["delayMs"].(float64) != 20 {
		t.Fatalf("default cond %v", cnd)
	}

	ctrl(t, c, map[string]any{"t": "preset", "id": "P02", "token": "wrong"})
	if e := next(t, c, "error"); !strings.Contains(e["msg"].(string), "token") {
		t.Fatal(e)
	}
	ctrl(t, c, map[string]any{"t": "preset", "id": "P11", "token": "secret"})
	if e := next(t, c, "error"); !strings.Contains(e["msg"].(string), "not built") {
		t.Fatal(e)
	}
	ctrl(t, c, map[string]any{"t": "preset", "id": "P02", "token": "secret"})
	s := next(t, c, "settings")
	if s["presetId"] != "P02" || s["settings"].(map[string]any)["predict"] != false || s["banner"] == "" {
		t.Fatalf("P02 %v", s)
	}
	ctrl(t, c, map[string]any{"t": "lab", "token": "secret", "settings": map[string]any{"tickRate": 128, "sendRate": 64}})
	s = next(t, c, "settings")
	if s["settings"].(map[string]any)["tickRate"].(float64) != 128 {
		t.Fatalf("lab %v", s)
	}
	ctrl(t, c, map[string]any{"t": "lab", "token": "secret", "settings": map[string]any{"sendRate": 30, "tickRate": 20}})
	if e := next(t, c, "error"); !strings.Contains(e["msg"].(string), "sendRate") {
		t.Fatal(e)
	}
	ctrl(t, c, map[string]any{"t": "cond", "up": map[string]any{"delayMs": 50, "lossPct": 5}})
	cd := next(t, c, "cond")["cond"].(map[string]any)["up"].(map[string]any)
	if cd["delayMs"].(float64) != 50 || cd["lossPct"].(float64) != 5 {
		t.Fatalf("cond %v", cd)
	}
	ctrl(t, c, map[string]any{"t": "cond", "all": true, "up": map[string]any{"delayMs": 0}})
	if e := next(t, c, "error"); !strings.Contains(e["msg"].(string), "admin token") {
		t.Fatal(e)
	}
	ctrl(t, c, map[string]any{"t": "statsReset", "token": "secret"})
	next(t, c, "statsReset") // the server must survive it (bots' crash report)
	st := next(t, c, "stats")
	if st["tick"].(map[string]any)["samples"].(float64) <= 0 {
		t.Fatalf("stats %v", st)
	}
}

func TestTickStats(t *testing.T) {
	d := make([]float64, 64)
	for i := range d {
		d[i] = 1
	}
	d[63] = 20 // one tick over the 15.6 ms budget
	ts := tickStats(d, 64)
	if ts.Samples != 64 || ts.MaxMs != 20 || ts.WithinBudgetPct > 98.5 || ts.WithinBudgetPct < 98.4 {
		t.Fatalf("%+v", ts)
	}
}

// A host stall must not turn into a misprediction: catch-up ticks with no
// input hold the player (counted), on-time ticks repeat input (counted, A.14).
func TestCatchUpHoldsOnTimeStarves(t *testing.T) {
	room := NewRoom(slog.New(slog.NewTextHandler(io.Discard, nil)), "x")
	c := &Client{room: room, inbuf: map[uint32]sim.Cmd{}, recvMs: map[uint32]float64{}, started: true, alive: true, lastInput: sim.Input{Buttons: sim.BtnForward}}
	c.state = sim.State{Pos: room.m.Spawn("blue", 0), OnGround: true}
	before := c.state
	c.simulate(sim.DtForRate(64), true, DefaultSettings(), 1)
	if c.held != 1 || c.starved != 0 || c.state != before {
		t.Fatalf("catch-up: held=%d starved=%d moved=%v", c.held, c.starved, c.state != before)
	}
	c.simulate(sim.DtForRate(64), false, DefaultSettings(), 2)
	if c.starved != 1 || c.state == before {
		t.Fatalf("on-time: starved=%d moved=%v", c.starved, c.state != before)
	}
}

func TestHistPercentiles(t *testing.T) {
	var h hist
	for i := 1; i <= 1000; i++ {
		h.add(float64(i)/100, 5) // 0.01 .. 10 ms
	}
	s := h.stats()
	if s.Samples != 1000 || s.P50Ms < 4.99 || s.P50Ms > 5.01 || s.P99Ms == nil || *s.P99Ms < 9.89 || *s.P99Ms > 9.91 || s.OverBudget != 500 || s.MaxMs != 10 {
		t.Fatalf("%+v p99=%v", s, *s.P99Ms)
	}
	var small hist
	small.add(1, 5)
	if small.stats().P99Ms != nil {
		t.Fatal("p99 must be absent under 100 samples")
	}
	if g := readGC(); g.Goroutines == 0 {
		t.Fatalf("gc stats %+v", g)
	}
}

func TestBudgetEstimateMatchesA11(t *testing.T) {
	total := func(s Settings) float64 { return budgetEst(s, DefaultCond())["totalMs"].(float64) }
	if v := total(DefaultSettings()); v < 189 || v > 191 {
		t.Fatalf("default %f, A.11 says ~190", v)
	}
	s := DefaultSettings()
	s.SendRate = 64
	if v := total(s); v < 101 || v > 105 {
		t.Fatalf("64/s %f, A.11 says ~103", v)
	}
	s.TickRate, s.SendRate, s.FPSCap = 128, 128, 144
	if v := total(s); v < 68 || v > 74 {
		t.Fatalf("128 Hz + 144 FPS %f, A.11 says ~71", v)
	}
}

func TestHistResetKeepsMutex(t *testing.T) {
	var h hist
	h.add(3, 1)
	h.reset() // used to be fatal: sync: unlock of unlocked mutex
	h.add(1, 5)
	if s := h.stats(); s.Samples != 1 || s.OverBudget != 0 || s.MaxMs != 1 {
		t.Fatalf("%+v", s)
	}
}

// DECISIONS 51: an input stamped for a later tick waits; an overdue one is
// caught up (two per tick); a missing input that is not due yet is not a
// starvation.
func TestScheduledPlay(t *testing.T) {
	room := NewRoom(slog.New(slog.NewTextHandler(io.Discard, nil)), "x")
	c := &Client{room: room, inbuf: map[uint32]sim.Cmd{}, recvMs: map[uint32]float64{}, started: true, alive: true}
	c.state = sim.State{Pos: room.m.Spawn("blue", 0), OnGround: true}
	dt, s := sim.DtForRate(64), DefaultSettings()
	for seq := uint32(1); seq <= 3; seq++ {
		c.inbuf[seq] = sim.Cmd{Seq: seq, ClientTick: 100 + seq, In: sim.Input{Buttons: sim.BtnForward}}
	}
	c.simulate(dt, false, s, 100) // input 1 is for tick 101: wait
	if c.lastProcessed != 0 || c.waitedEarly != 1 {
		t.Fatalf("early input consumed: last=%d waited=%d", c.lastProcessed, c.waitedEarly)
	}
	c.simulate(dt, false, s, 101)
	if c.lastProcessed != 1 {
		t.Fatalf("due input not consumed: %d", c.lastProcessed)
	}
	c.simulate(dt, false, s, 104) // inputs 2 (102) and 3 (103) are overdue: catch up two
	if c.lastProcessed != 3 || c.starved != 0 {
		t.Fatalf("catch-up: last=%d starved=%d", c.lastProcessed, c.starved)
	}
	c.simulate(dt, false, s, 104) // next input would be for 104: due and missing -> starvation (A.14)
	if c.starved != 1 {
		t.Fatalf("starved %d", c.starved)
	}
	c.simulate(dt, false, s, 104) // its slot was used by the repeat; the next is for 105: wait, no starvation
	if c.starved != 1 {
		t.Fatalf("not-yet-due input counted as starvation: %d", c.starved)
	}
}

// review V14: a snapshot window with no input arrivals reports LeadNone, not the old lead.
func TestInputLeadNotStale(t *testing.T) {
	r := NewRoom(slog.New(slog.NewTextHandler(io.Discard, nil)), "x")
	c := testClient(r, 1, 0, [3]sim.Fx{})
	c.minLead, c.haveMinLead = 2, true
	var s codec.Snapshot
	r.fillSnapshot(c, &s, 1, 0, nil, DefaultSettings())
	if s.Own.InputLead != 2 {
		t.Fatalf("lead %d want 2", s.Own.InputLead)
	}
	s = codec.Snapshot{}
	r.fillSnapshot(c, &s, 2, 0, nil, DefaultSettings())
	if s.Own.InputLead != codec.LeadNone {
		t.Fatalf("empty window reported %d, want LeadNone", s.Own.InputLead)
	}
}

// P10: the scorecard for every combination of the five toggles, against
// A.2/A.5/A.10: Instant = prediction + reconciliation (or trust: the client
// simulates itself), Smooth = interpolation, Fair = lag compensation (or
// trust: the client claims its hits), Cheat-proof = server authority.
func TestScorecardAllCombinations(t *testing.T) {
	for mask := 0; mask < 32; mask++ {
		s := DefaultSettings()
		s.Authority = map[bool]string{true: "trust", false: "server"}[mask&1 != 0]
		s.Predict, s.Reconcile, s.Interp, s.LagComp = mask&2 != 0, mask&4 != 0, mask&8 != 0, mask&16 != 0
		trust := s.Authority == "trust"
		want := map[string]bool{
			"instant":    trust || (s.Predict && s.Reconcile),
			"smooth":     s.Interp,
			"fair":       trust || s.LagComp,
			"cheatProof": !trust,
		}
		got := scorecard(s)
		for k, v := range want {
			if got[k] != v {
				t.Fatalf("%+v: %s = %v, want %v", s, k, got[k], v)
			}
		}
		allGreen := got["instant"] && got["smooth"] && got["fair"] && got["cheatProof"]
		if allGreen != (!trust && s.Predict && s.Reconcile && s.Interp && s.LagComp) {
			t.Fatalf("all green only with predict, reconcile, interp, lagcomp and authority (B.6 P10): %+v", s)
		}
	}
	// The presets as the teaching sequence shows them.
	card := func(id string) map[string]bool {
		for _, p := range Presets() {
			if p.ID == id {
				s := DefaultSettings()
				p.apply(&s)
				return scorecard(s)
			}
		}
		t.Fatalf("no preset %s", id)
		return nil
	}
	if c := card("P02"); c["instant"] || !c["cheatProof"] {
		t.Fatalf("P02 dumb client: Instant ✗, Cheat-proof ✓ (A.4): %v", c)
	}
	if c := card("P03"); !c["instant"] || !c["fair"] || c["cheatProof"] {
		t.Fatalf("P03 trust: Instant ✓, Fair ✓, Cheat-proof ✗ (A.5): %v", c)
	}
	if c := card("P06"); c["smooth"] {
		t.Fatalf("P06 raw snapshots: Smooth ✗ (A.8): %v", c)
	}
	if c := card("P08"); c["fair"] {
		t.Fatalf("P08 three truths: Fair ✗ (A.10): %v", c)
	}
	if c := card("P10"); !(c["instant"] && c["smooth"] && c["fair"] && c["cheatProof"]) {
		t.Fatalf("P10: all green: %v", c)
	}
}

func TestGlitches(t *testing.T) {
	room, url := newTestServer(t)
	c, err := transport.DialWS(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close("")
	ctrl(t, c, map[string]any{"t": "join", "name": "g"})
	next(t, c, "welcome")
	ctrl(t, c, map[string]any{"t": "glitch", "token": "secret", "kind": "rubberband", "on": true})
	g := next(t, c, "glitch")
	if g["name"] != "Rubber-banding" || g["speedScale"].(float64) != 0.6 {
		t.Fatalf("%v", g)
	}
	room.mu.Lock()
	scale := room.params.SpeedScale
	room.mu.Unlock()
	if scale != sim.FromFloat(0.6) {
		t.Fatalf("server speed scale %v", scale)
	}
	ctrl(t, c, map[string]any{"t": "glitch", "token": "secret", "kind": "lossBurst", "ms": 150})
	g = next(t, c, "glitch")
	if g["name"] != "Teleporting" || g["targets"].(float64) != 1 {
		t.Fatalf("%v", g)
	}
	room.mu.Lock()
	cl := room.clients[1]
	room.mu.Unlock()
	if cl.down.Params().LossPct != 100 {
		t.Fatal("burst not applied")
	}
	time.Sleep(400 * time.Millisecond)
	if cl.down.Params().LossPct != 0 {
		t.Fatal("burst not restored")
	}
	ctrl(t, c, map[string]any{"t": "glitch", "token": "nope", "kind": "lossBurst"})
	if e := next(t, c, "error"); !strings.Contains(e["msg"].(string), "token") {
		t.Fatal(e)
	}
}
