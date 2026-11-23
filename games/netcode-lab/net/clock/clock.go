// Package clock estimates the server clock and tick from ping/pong (B.4 rule 3):
// NTP-style offset, using the median of the lowest-RTT recent samples.
package clock

import (
	"math"
	"sort"

	"netcodelab/net/codec"
)

const window = 16

type sample struct {
	rtt, offset float64
}

// Sync is not safe for concurrent use.
type Sync struct {
	samples []sample
	last    codec.Pong
	lastRTT float64
	jitter  float64 // mean |delta RTT|, EWMA 1/8
	n       int
}

// OnPong adds a sample. clientRecvMs is the client's clock when the pong arrived.
func (s *Sync) OnPong(p codec.Pong, clientRecvMs float64) {
	rtt := (clientRecvMs - p.ClientSendMs) - (p.ServerSendMs - p.ServerRecvMs)
	if rtt < 0 {
		rtt = 0
	}
	off := ((p.ServerRecvMs - p.ClientSendMs) + (p.ServerSendMs - clientRecvMs)) / 2
	if s.n > 0 {
		s.jitter += (math.Abs(rtt-s.lastRTT) - s.jitter) / 8
	}
	s.lastRTT = rtt
	s.n++
	s.samples = append(s.samples, sample{rtt, off})
	if len(s.samples) > window {
		s.samples = s.samples[1:]
	}
	s.last = p
}

// Ready reports whether at least one pong arrived.
func (s *Sync) Ready() bool { return s.n > 0 }

// Estimate is the current view of the server clock.
type Estimate struct {
	OffsetMs  float64 `json:"offsetMs"` // serverTime = clientTime + offset
	RTTMs     float64 `json:"rttMs"`    // median RTT of the window
	MinRTTMs  float64 `json:"minRttMs"`
	LastRTTMs float64 `json:"lastRttMs"`
	JitterMs  float64 `json:"jitterMs"`
	Samples   int     `json:"samples"`
}

func (s *Sync) Estimate() Estimate {
	if len(s.samples) == 0 {
		return Estimate{}
	}
	sorted := append([]sample(nil), s.samples...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].rtt < sorted[j].rtt })
	best := sorted[:max(1, min(len(sorted), max(3, len(sorted)/2)))]
	offs := make([]float64, len(best))
	for i, b := range best {
		offs[i] = b.offset
	}
	sort.Float64s(offs)
	return Estimate{
		OffsetMs:  offs[len(offs)/2],
		RTTMs:     sorted[len(sorted)/2].rtt,
		MinRTTMs:  sorted[0].rtt,
		LastRTTMs: s.lastRTT,
		JitterMs:  s.jitter,
		Samples:   s.n,
	}
}

// ServerTimeMs maps a client time to the estimated server time.
func (s *Sync) ServerTimeMs(clientNowMs float64) float64 {
	return clientNowMs + s.Estimate().OffsetMs
}

// ServerTick estimates the server tick (with fraction) at a client time, from
// the last pong's tick position. Valid while the tick rate is unchanged.
func (s *Sync) ServerTick(clientNowMs float64) float64 {
	if s.n == 0 || s.last.TickRate == 0 {
		return 0
	}
	base := float64(s.last.ServerTick) + float64(s.last.TickFrac)/65536
	elapsed := s.ServerTimeMs(clientNowMs) - s.last.ServerSendMs
	return base + elapsed*float64(s.last.TickRate)/1000
}

// TickRate is the server tick rate reported by the last pong.
func (s *Sync) TickRate() int { return int(s.last.TickRate) }

// TargetClientTick is the tick the client should stamp on an input it sends
// now: ahead of the server by RTT/2 plus marginTicks, so the input arrives just
// before the tick that needs it.
func (s *Sync) TargetClientTick(clientNowMs float64, marginTicks float64) uint32 {
	e := s.Estimate()
	rate := float64(s.last.TickRate)
	ahead := e.RTTMs/2*rate/1000 + marginTicks
	return uint32(math.Ceil(s.ServerTick(clientNowMs) + ahead))
}
