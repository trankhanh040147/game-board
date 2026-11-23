package clock

// Pacer decides when the client sends inputs (B.4 rule 3). Inputs are stamped
// with the server tick they are meant for, and sent RTT/2 + Margin ticks ahead
// of the estimated server tick, so they arrive just before the tick that needs
// them. When the server reports that it had to repeat an input (its buffer
// ran empty), the margin grows by one tick (at most once per second, so one
// stall counts once); after 2 s without starvation it shrinks by one tick
// per second back to MinMargin. This keeps input latency low without starving the server.
type Pacer struct {
	Margin    float64 // ticks; starts at MinMargin
	MinMargin float64
	MaxMargin float64

	lastSent    uint32
	started     bool
	lastStarved uint16
	haveStarved bool
	calmSince   float64
	raisedAt    float64
	raisedOnce  bool
	drainedAt   float64 // last time the margin was lowered
	drainedTo   float64
	floor       float64 // lowest margin allowed until floorUntil
	floorUntil  float64
	Adjustments int // times the margin was raised
}

func NewPacer() *Pacer { return &Pacer{Margin: 1, MinMargin: 1, MaxMargin: 6} }

// Due returns the client ticks to send inputs for now (oldest first), at most 4.
// It returns nil until the clock has a sample.
func (p *Pacer) Due(s *Sync, nowMs float64) []uint32 {
	if !s.Ready() {
		return nil
	}
	target := s.TargetClientTick(nowMs, p.Margin)
	if !p.started || int64(target)-int64(p.lastSent) > 8 || int64(target)-int64(p.lastSent) < -8 {
		// first input, or the estimate jumped (tick-rate change): resync
		p.started = true
		p.lastSent = target - 1
	}
	var out []uint32
	for int32(target-p.lastSent) > 0 && len(out) < 4 {
		p.lastSent++
		out = append(out, p.lastSent)
	}
	return out
}

// OnServerFeedback takes the server's cumulative starvation counter from a
// snapshot (OwnState.Starved).
func (p *Pacer) OnServerFeedback(starved uint16, nowMs float64) {
	if !p.haveStarved {
		p.haveStarved, p.lastStarved, p.calmSince = true, starved, nowMs
		return
	}
	if starved != p.lastStarved {
		p.lastStarved = starved
		// Starving soon after draining to a level means that level is too
		// low for this host right now: do not probe it again for 30 s.
		// Without this the margin oscillates (drain to 1, starve, raise,
		// drain...) and each cycle is a correction.
		if p.drainedAt > 0 && nowMs-p.drainedAt < 4000 {
			p.floor, p.floorUntil = p.drainedTo+1, nowMs+30000
		}
		// One raise per burst: starvations within 1 s of a raise belong to
		// the same stall and do not raise again.
		if !p.raisedOnce || nowMs-p.raisedAt > 1000 {
			p.raisedOnce = true
			p.Margin = min(p.MaxMargin, p.Margin+1)
			p.Adjustments++
			p.raisedAt = nowMs
		}
		p.calmSince = nowMs
		return
	}
	// Calm for 2 s: give back one tick per second, so a stall's raise
	// drains within seconds on a calm host (6 -> 1 in about 7 s).
	low := p.MinMargin
	if nowMs < p.floorUntil {
		low = max(low, p.floor)
	}
	if nowMs-p.calmSince > 2000 && p.Margin > low {
		p.Margin = max(low, p.Margin-1)
		p.calmSince = nowMs - 1000
		p.drainedAt, p.drainedTo = nowMs, p.Margin
	}
}
