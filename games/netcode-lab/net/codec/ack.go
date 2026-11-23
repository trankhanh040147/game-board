package codec

import "sync"

// SeqGreater reports a > b with u16 wraparound.
func SeqGreater(a, b uint16) bool {
	return (a > b && a-b <= 32768) || (a < b && b-a > 32768)
}

type sentRec struct {
	seq   uint16
	at    float64
	valid bool
	acked bool
}

// Endpoint is one side's ack state: it numbers outgoing packets, tracks which
// remote packets arrived (ack + 32-bit history), and learns which of its own
// packets were acked. It measures RTT and loss from acks alone.
type Endpoint struct {
	mu sync.Mutex

	localSeq uint16
	sent     [1024]sentRec
	lossNext uint16 // next own seq to judge as lost once it leaves the ack window

	remoteSeq  uint16
	remoteBits uint32
	haveRemote bool

	Stats EndpointStats
}

type EndpointStats struct {
	Sent       uint64
	Acked      uint64
	Lost       uint64  // own packets that left the 33-packet ack window unacked
	RTTMs      float64 // smoothed RTT from acks (EWMA 1/8)
	Received   uint64  // unique remote packets
	Duplicates uint64
	Old        uint64 // remote packets older than the 32-packet window
	RemoteGaps uint64 // remote seqs skipped (lost or not yet arrived)
}

// NextHeader numbers the next outgoing packet and stamps the current ack state.
func (e *Endpoint) NextHeader(typ uint8, nowMs float64) Header {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.localSeq++
	s := e.localSeq
	r := &e.sent[s%uint16(len(e.sent))]
	if r.valid && !r.acked && r.seq != s {
		// overwritten before its fate was known (should not happen at <1024 in flight)
		e.Stats.Lost++
	}
	*r = sentRec{seq: s, at: nowMs, valid: true}
	e.Stats.Sent++
	if e.Stats.Sent == 1 {
		e.lossNext = s
	}
	return Header{Type: typ, Seq: s, Ack: e.remoteSeq, AckBits: e.remoteBits}
}

// OnReceive records a remote packet. It returns dup=true for duplicates or
// packets too old to track; the caller should still parse it if it wants.
func (e *Endpoint) OnReceive(h Header, nowMs float64) (dup bool, newlyAcked int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	// Remote sequence tracking.
	switch {
	case !e.haveRemote:
		e.haveRemote, e.remoteSeq, e.remoteBits = true, h.Seq, 0
		e.Stats.Received++
	case SeqGreater(h.Seq, e.remoteSeq):
		d := uint32(h.Seq - e.remoteSeq)
		if d >= 32 {
			e.remoteBits = 0
		} else {
			e.remoteBits = e.remoteBits<<d | 1<<(d-1)
		}
		e.Stats.RemoteGaps += uint64(d - 1)
		e.remoteSeq = h.Seq
		e.Stats.Received++
	default:
		d := uint32(e.remoteSeq - h.Seq)
		if d == 0 || d > 32 {
			if d == 0 {
				e.Stats.Duplicates++
			} else {
				e.Stats.Old++
			}
			dup = true
		} else if e.remoteBits&(1<<(d-1)) != 0 {
			e.Stats.Duplicates++
			dup = true
		} else {
			e.remoteBits |= 1 << (d - 1)
			e.Stats.Received++
			if e.Stats.RemoteGaps > 0 {
				e.Stats.RemoteGaps-- // a late packet fills a gap
			}
		}
	}
	// Acks of our own packets.
	if e.Stats.Sent == 0 {
		return
	}
	newlyAcked += e.ackOne(h.Ack, nowMs)
	for i := uint16(0); i < 32; i++ {
		if h.AckBits&(1<<i) != 0 {
			newlyAcked += e.ackOne(h.Ack-1-i, nowMs)
		}
	}
	// Anything older than ack-32 that is still unacked is lost.
	limit := h.Ack - 32
	for SeqGreater(limit, e.lossNext) && SeqGreater(e.localSeq+1, e.lossNext) {
		r := &e.sent[e.lossNext%uint16(len(e.sent))]
		if r.valid && r.seq == e.lossNext && !r.acked {
			e.Stats.Lost++
			r.valid = false
		}
		e.lossNext++
	}
	return
}

func (e *Endpoint) ackOne(s uint16, nowMs float64) int {
	if SeqGreater(s, e.localSeq) {
		return 0
	}
	r := &e.sent[s%uint16(len(e.sent))]
	if !r.valid || r.seq != s || r.acked {
		return 0
	}
	r.acked = true
	e.Stats.Acked++
	sample := nowMs - r.at
	if e.Stats.RTTMs == 0 {
		e.Stats.RTTMs = sample
	} else {
		e.Stats.RTTMs += (sample - e.Stats.RTTMs) / 8
	}
	return 1
}

// Snapshot returns a copy of the stats.
func (e *Endpoint) Snapshot() EndpointStats {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.Stats
}
