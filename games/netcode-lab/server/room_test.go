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
	ctrl(t, c, map[string]any{"t": "preset", "id": "P03", "token": "secret"})
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
	c := &Client{room: room, inbuf: map[uint32]sim.Cmd{}, started: true, lastInput: sim.Input{Buttons: sim.BtnForward}}
	c.state = sim.State{Pos: room.m.Spawn("blue", 0), OnGround: true}
	before := c.state
	c.simulate(sim.DtForRate(64), true)
	if c.held != 1 || c.starved != 0 || c.state != before {
		t.Fatalf("catch-up: held=%d starved=%d moved=%v", c.held, c.starved, c.state != before)
	}
	c.simulate(sim.DtForRate(64), false)
	if c.starved != 1 || c.state == before {
		t.Fatalf("on-time: starved=%d moved=%v", c.starved, c.state != before)
	}
}
