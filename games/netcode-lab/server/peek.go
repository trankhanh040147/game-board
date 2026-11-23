package server

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"time"
)

// PeekRunner runs the P14 peek test (holder + peeker bots against this
// server) and returns the bots' "peek" report. cmd/server supplies it; it runs
// bots' cmd/bot -kind peek, so the server and the CLI measure the same way.
type PeekRunner func(ctx context.Context, crossings, bufferMs int) (json.RawMessage, error)

// peekRef is Riot's published peeker's-advantage figures (A.11), shown next
// to our measurement as ref, never as ours.
var peekRef = map[string]any{
	"label":  "ref",
	"source": "Riot Games, VALORANT netcode (A.11)",
	"values": []map[string]any{
		{"what": "baseline", "ms": 141},
		{"what": "after netcode work (derived: Riot published only the ~40 ms cut)", "ms": 101},
		{"what": "with 144 FPS clients", "ms": 71},
	},
	"note": "a different game, network and measurement; for scale only",
}

type peekState struct {
	runner PeekRunner
	busy   atomic.Bool
}

// SetPeekRunner enables {t:"peekTest"} (P14).
func (r *Room) SetPeekRunner(f PeekRunner) { r.peek.runner = f }

func (r *Room) handlePeek(c *Client, in ctrlIn) {
	if !r.checkToken(in.Token) {
		r.errorTo(c, "peekTest: bad admin token")
		return
	}
	if r.peek.runner == nil {
		r.errorTo(c, "peekTest: not available on this server (no bot binary)")
		return
	}
	if !r.peek.busy.CompareAndSwap(false, true) {
		r.errorTo(c, "peekTest: already running")
		return
	}
	crossings := in.Crossings
	if crossings <= 0 {
		crossings = 10
	}
	crossings = min(crossings, 40)
	r.mu.Lock()
	s := r.settings
	cp := r.defCond
	r.mu.Unlock()
	buf := s.InterpMs
	if s.InterpAuto {
		buf = int(s.InterpK * 1000 / float64(s.SendRate))
	}
	setup := map[string]any{"tickRate": s.TickRate, "sendRate": s.SendRate, "interpMs": buf, "fpsCap": s.FPSCap,
		"lagcomp": s.LagComp, "cond": cp, "condLabel": "simulated"}
	r.broadcast(map[string]any{"t": "peekTest", "state": "running", "crossings": crossings, "setup": setup, "serverTimeMs": r.NowMs()})
	go func() {
		defer r.peek.busy.Store(false)
		ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
		defer cancel()
		res, err := r.peek.runner(ctx, crossings, buf)
		msg := map[string]any{"t": "peekTest", "setup": setup, "ref": peekRef, "serverTimeMs": r.NowMs()}
		if err != nil {
			msg["state"], msg["error"] = "error", err.Error()
			r.log.Warn("peek test", "err", err)
		} else {
			msg["state"], msg["result"] = "done", res
		}
		r.broadcast(msg)
	}()
}
