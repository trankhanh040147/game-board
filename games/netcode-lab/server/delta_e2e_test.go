package server

import (
	"context"
	"testing"
	"time"

	"netcodelab/net/codec"
	"netcodelab/sim"
)

// P27 over the wire: with quant + bitpack + delta, a client that acks SnapID
// and keeps baselines sees the other player where the server has it (to
// 1/256 m), and most snapshots are deltas.
func TestDeltaSnapshotsOverTheWire(t *testing.T) {
	room, url := newTestServer(t)
	a := joinE2E(t, url, "receiver")
	b := joinE2E(t, url, "mover")
	ctrl(t, a.conn, map[string]any{"t": "preset", "id": "P27", "token": "secret"})
	next(t, a.conn, "settings")

	var store codec.Baselines
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	deltas, checked := 0, 0
	for n := 0; n < 50; n++ {
		// Move b on the server between snapshots (sometimes not: at rest).
		if n%3 != 0 {
			room.mu.Lock()
			room.clients[b.id].state.Pos[0] += sim.FromFloat(0.37)
			room.mu.Unlock()
		}
		var s codec.Snapshot
		for {
			m, err := a.conn.Recv(ctx)
			if err != nil {
				t.Fatalf("snapshot %d: %v", n, err)
			}
			if m.Control {
				continue
			}
			r := codec.Reader{B: m.Data}
			h := r.Header()
			if h.Type != codec.TSnapshot {
				continue
			}
			codec.ReadSnapshotWith(&r, &s, &store)
			if r.Err != nil {
				t.Fatalf("decode %d: %v", n, r.Err)
			}
			break
		}
		var w codec.Writer
		codec.AppendSnapshotAck(&w, a.ep.NextHeader(codec.TSnapshotAck, 0), &codec.SnapshotAck{BaselineID: s.SnapID, ServerTick: s.ServerTick})
		a.conn.SendDatagram(w.B)
		if s.BaselineID != 0 {
			deltas++
		}
		if s.Encoding&codec.EncQuant == 0 {
			continue // snapshots sent before the preset took effect
		}
		room.mu.Lock()
		hist := room.hist.at(s.ServerTick)
		var truth histPlayer
		ok := false
		if hist != nil {
			truth, ok = hist.find(b.id)
		}
		room.mu.Unlock()
		if !ok {
			continue
		}
		for _, e := range s.Entities {
			if e.ID == b.id {
				if d := e.Pos[0] - truth.pos[0]; d > 128 || d < -128 {
					t.Fatalf("snapshot %d: decoded x off by %d units (> 1/512 m)", n, d)
				}
				checked++
			}
		}
	}
	if deltas < 30 || checked < 30 {
		t.Fatalf("deltas %d, checked %d of 50", deltas, checked)
	}
	t.Logf("50 snapshots: %d deltas, %d positions checked against server history", deltas, checked)
}
