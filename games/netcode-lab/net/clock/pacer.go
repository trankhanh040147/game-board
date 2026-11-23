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

	lastSent     uint32
	started      bool
	lastStarved  uint16
	haveStarved  bool
	calmSince    float64
	raisedAt     float64
	raisedOnce   bool
	drainedAt    float64 // last time the margin was lowered
	drainedTo    float64
	floor        float64 // lowest margin allowed until floorUntil
	floorUntil   float64
	leadWinStart float64
	leadWinMin   int
	Adjustments  int // times the margin was raised
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

// LeadMinMargin is the lowest margin in lead mode. The margin may go below
// zero: RTT/2 and the clock offset are estimates, and only the measured lead
// says how early inputs really arrive.
const LeadMinMargin = -4

// OnServerLead is the feedback for a server that plays inputs at their
// stamped tick (DECISIONS 51). lead is the snapshot's own.inputLead: the
// smallest (stamped tick - server tick at arrival) since the previous
// snapshot; 1 means just in time. Rules:
//   - a starvation raises the margin by 1 (at most once per second), with the
//     same 30 s probe floor as OnServerFeedback;
//   - if every lead seen in the last 2 s was >= 2 ticks and nothing was
//     raised or lowered for 2 s, the margin drops by 1.
//
// So the margin settles at the smallest value whose inputs still arrive
// with at least one tick to spare.
func (p *Pacer) OnServerLead(starved uint16, lead int8, nowMs float64) {
	if !p.haveStarved {
		p.haveStarved, p.lastStarved, p.calmSince = true, starved, nowMs
		p.leadWinStart, p.leadWinMin = nowMs, 127
		return
	}
	if starved != p.lastStarved {
		p.lastStarved = starved
		if p.drainedAt > 0 && nowMs-p.drainedAt < 4000 {
			p.floor, p.floorUntil = p.drainedTo+1, nowMs+30000
		}
		if !p.raisedOnce || nowMs-p.raisedAt > 1000 {
			p.raisedOnce = true
			p.Margin = min(p.MaxMargin, p.Margin+1)
			p.Adjustments++
			p.raisedAt = nowMs
		}
		p.calmSince = nowMs
		p.leadWinStart, p.leadWinMin = nowMs, 127
		return
	}
	if lead != 127 { // 127 = no input arrived in that snapshot window: no news
		p.leadWinMin = min(p.leadWinMin, int(lead))
	}
	if nowMs-p.leadWinStart < 2000 || nowMs-p.calmSince < 2000 {
		return
	}
	low := float64(LeadMinMargin)
	if nowMs < p.floorUntil {
		low = max(low, p.floor)
	}
	// A window with no news (127 throughout) is not evidence of slack.
	if p.leadWinMin >= 2 && p.leadWinMin != 127 && p.Margin > low {
		p.Margin = max(low, p.Margin-1)
		p.drainedAt, p.drainedTo = nowMs, p.Margin
		p.calmSince = nowMs // let the new margin show in the leads before the next step
	}
	p.leadWinStart, p.leadWinMin = nowMs, 127
}
