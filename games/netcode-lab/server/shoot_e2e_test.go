package server

import (
	"context"
	"testing"
	"time"

	"netcodelab/net/codec"
	"netcodelab/net/transport"
	"netcodelab/sim"
)

type e2eClient struct {
	conn transport.Conn
	ep   codec.Endpoint
	id   uint8
}

func joinE2E(t *testing.T, url, name string) *e2eClient {
	c, err := transport.DialWS(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close("") })
	ctrl(t, c, map[string]any{"t": "join", "name": name})
	w := next(t, c, "welcome")
	return &e2eClient{conn: c, id: uint8(w["id"].(float64))}
}

// readEvents reads datagrams until an event of type typ arrives, acking snapshots.
func (c *e2eClient) readEvent(t *testing.T, typ uint8) codec.Event {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		m, err := c.conn.Recv(ctx)
		if err != nil {
			t.Fatalf("waiting for event %d: %v", typ, err)
		}
		if m.Control {
			continue
		}
		r := codec.Reader{B: m.Data}
		h := r.Header()
		c.ep.OnReceive(h, 0)
		if h.Type != codec.TSnapshot {
			continue
		}
		var s codec.Snapshot
		codec.ReadSnapshot(&r, &s)
		var w codec.Writer
		codec.AppendSnapshotAck(&w, c.ep.NextHeader(codec.TSnapshotAck, 0), &codec.SnapshotAck{ServerTick: s.ServerTick})
		c.conn.SendDatagram(w.B)
		for _, e := range s.Events {
			if e.Type == typ {
				return e
			}
		}
	}
}

// The full path: fire input over WebSocket -> playout buffer -> lag-comp
// resolution -> shot result to the shooter and damage to the victim, both in
// snapshots (through the default 20 ms conditioner).
func TestShootOverTheWire(t *testing.T) {
	room, url := newTestServer(t)
	a := joinE2E(t, url, "shooter")
	b := joinE2E(t, url, "target")
	f := sim.FromFloat
	room.mu.Lock()
	room.clients[a.id].state = sim.State{Pos: [3]sim.Fx{0, 0, f(-10)}, OnGround: true}
	room.clients[b.id].state = sim.State{Pos: [3]sim.Fx{0, 0, f(-20)}, OnGround: true}
	tick := room.tick.Load()
	room.mu.Unlock()

	// Two inputs prime the server's playout buffer; the second fires at the target (yaw 0 = -Z).
	var w codec.Writer
	cmds := []sim.Cmd{
		{Seq: 1, ClientTick: tick + 2},
		{Seq: 2, ClientTick: tick + 3, In: sim.Input{Buttons: sim.BtnFire}, RenderTick: tick},
	}
	codec.AppendInput(&w, a.ep.NextHeader(codec.TInput, 0), &codec.Input{Cmds: cmds})
	if err := a.conn.SendDatagram(w.B); err != nil {
		t.Fatal(err)
	}
	ev := a.readEvent(t, codec.EvShotResult)
	var sr codec.ShotResult
	sr.Read(&codec.Reader{B: ev.Data})
	if sr.ShotSeq != 2 || sr.HitID != b.id || sr.Damage == 0 || sr.RecvMs <= 0 || sr.TickStartMs < sr.RecvMs {
		t.Fatalf("shot result %+v", sr)
	}
	dev := b.readEvent(t, codec.EvDamage)
	var dm codec.Damage
	dm.Read(&codec.Reader{B: dev.Data})
	if dm.ShooterID != a.id || dm.ShotSeq != 2 || dm.Health != 100-sr.Damage {
		t.Fatalf("damage %+v", dm)
	}
}
