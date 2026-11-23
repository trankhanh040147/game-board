package server

import (
	"sync/atomic"

	"netcodelab/net/codec"
)

// Per-client byte counters (M5 cost meters, P12). Payload bytes only: the
// WebSocket/QUIC framing and IP headers are not counted.
type byteCounters struct {
	downDatagram atomic.Uint64 // server -> client hot path, after the conditioner (what was really sent)
	downControl  atomic.Uint64
	upDatagram   atomic.Uint64 // client -> server, as received (before the conditioner)
	upControl    atomic.Uint64
	snapshots    atomic.Uint64

	// last 1 Hz sample, owned by sendStats
	last   [5]uint64
	lastMs float64
}

func (b *byteCounters) now() [5]uint64 {
	return [5]uint64{b.downDatagram.Load(), b.downControl.Load(), b.upDatagram.Load(), b.upControl.Load(), b.snapshots.Load()}
}

// rates returns bytes/s (and snapshots/s) since the previous call.
func (b *byteCounters) rates(nowMs float64) map[string]float64 {
	cur := b.now()
	dt := (nowMs - b.lastMs) / 1000
	out := map[string]float64{}
	if b.lastMs > 0 && dt > 0 {
		names := []string{"downDatagramBps", "downControlBps", "upDatagramBps", "upControlBps", "snapshotsPerSec"}
		for i, n := range names {
			out[n] = float64(cur[i]-b.last[i]) / dt
		}
		out["downKbps"] = (out["downDatagramBps"] + out["downControlBps"]) * 8 / 1000
		out["upKbps"] = (out["upDatagramBps"] + out["upControlBps"]) * 8 / 1000
	}
	b.last, b.lastMs = cur, nowMs
	return out
}

// budgetEst is the A.11 formula (est.) for this client's current settings
// and simulated conditioner RTT: each "wait for the next X" is half its period.
func budgetEst(s Settings, cp CondPair) map[string]any {
	fps := float64(s.FPSCap)
	frame := 0.0
	if fps > 0 {
		frame = 1000 / fps / 2
	}
	up, down := cp.Up.DelayMs, cp.Down.DelayMs
	interp := float64(s.InterpMs)
	if s.InterpAuto {
		interp = s.InterpK * 1000 / float64(s.SendRate)
	}
	if !s.Interp {
		interp = 0
	}
	seg := []map[string]any{
		{"key": "shooterFrame", "label": "Shooter's frame wait (half a frame)", "ms": frame},
		{"key": "uplink", "label": "Uplink (simulated one-way delay)", "ms": up},
		{"key": "tickWait", "label": "Wait for server tick (half a tick)", "ms": 1000 / float64(s.TickRate) / 2},
		{"key": "snapshotWait", "label": "Wait for snapshot send (half an interval)", "ms": 1000 / float64(s.SendRate) / 2},
		{"key": "downlink", "label": "Downlink (simulated one-way delay)", "ms": down},
		{"key": "interp", "label": "Target's interpolation buffer", "ms": interp},
		{"key": "targetFrame", "label": "Target's frame wait (half a frame)", "ms": frame},
	}
	total := 0.0
	for _, x := range seg {
		total += x["ms"].(float64)
	}
	note := "est.: A.11 formula with this room's settings and your conditioner delays (simulated)"
	if fps == 0 {
		note += "; FPS uncapped, frame wait shown as 0 (client measures the real one)"
	}
	return map[string]any{"segments": seg, "totalMs": total, "label": "est.", "note": note}
}

// relayShotSeen forwards the target's half of a shot trace to the shooter.
func (r *Room) relayShotSeen(from *Client, in ctrlIn) {
	r.mu.Lock()
	sh, ok := r.clients[uint8(in.ShooterID)]
	r.mu.Unlock()
	if !ok || in.ShotSeq == 0 {
		return
	}
	r.send(sh, map[string]any{"t": "shotTrace", "shotSeq": in.ShotSeq, "targetId": from.id,
		"targetRecvServerMs": in.RecvMs, "targetInterpMs": in.InterpMs, "targetFrameServerMs": in.FrameMs})
}

// measureComp adds what this snapshot's entity list would cost in each P27
// encoding, whatever encoding is active, for the raw/quantised/delta meters.
func (r *Room) measureComp(c *Client, ents, acked []codec.Entity) {
	w := &r.compScratch
	c.comp[0].Add(uint64(codec.EntitySectionSize(w, 0, ents, nil)))
	c.comp[1].Add(uint64(codec.EntitySectionSize(w, codec.EncQuant, ents, nil)))
	c.comp[2].Add(uint64(codec.EntitySectionSize(w, codec.EncQuant|codec.EncBitpack, ents, nil)))
	full := codec.EncQuant | codec.EncBitpack | codec.EncDelta
	if acked == nil {
		full &^= codec.EncDelta // no acked baseline yet: delta degenerates to a full list
	}
	c.comp[3].Add(uint64(codec.EntitySectionSize(w, full, ents, acked)))
}

// compRates returns the P27 meters in bytes/s since the last call.
func (c *Client) compRates(dtSec float64) map[string]float64 {
	names := [4]string{"rawBps", "quantBps", "quantBitpackBps", "deltaBps"}
	out := map[string]float64{}
	for i := range c.comp {
		cur := c.comp[i].Load()
		if dtSec > 0 {
			out[names[i]] = float64(cur-c.compLast[i]) / dtSec
		}
		c.compLast[i] = cur
	}
	return out
}
