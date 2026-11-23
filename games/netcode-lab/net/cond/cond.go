// Package cond is the in-process network conditioner (B.2): per client and
// per direction it adds delay, jitter, loss, duplication and reordering.
// On a LAN (~1 ms RTT) it is what makes the default experience match A.1.
package cond

import (
	"math/rand/v2"
	"sync"
	"time"
)

// Params of one direction. Zero value = pass through.
type Params struct {
	DelayMs    float64 `json:"delayMs"`
	JitterMs   float64 `json:"jitterMs"`
	LossPct    float64 `json:"lossPct"`
	DupPct     float64 `json:"dupPct"`
	ReorderPct float64 `json:"reorderPct"`
}

// Clamp keeps params in the ranges the Lab allows.
func (p Params) Clamp() Params {
	c := func(v, lo, hi float64) float64 { return max(lo, min(hi, v)) }
	return Params{c(p.DelayMs, 0, 1000), c(p.JitterMs, 0, 500), c(p.LossPct, 0, 100), c(p.DupPct, 0, 100), c(p.ReorderPct, 0, 100)}
}

// Stats counted per link.
type Stats struct {
	In              uint64  `json:"in"`
	Delivered       uint64  `json:"delivered"`
	Dropped         uint64  `json:"dropped"`
	Duplicated      uint64  `json:"duplicated"`
	Reordered       uint64  `json:"reordered"`
	Retransmitted   uint64  `json:"retransmitted"`   // ordered mode: lost segments, delivered late
	FastRetransmits uint64  `json:"fastRetransmits"` // of which recovered by 3 duplicate ACKs
	RTOs            uint64  `json:"rtos"`            // of which recovered by the retransmission timeout
	MaxStallMs      float64 `json:"maxStallMs"`      // longest extra delay a retransmit added
	Backoffs        uint64  `json:"backoffs"`        // retransmissions lost again (RTO doubled)
}

type item struct {
	at        time.Time
	n         uint64
	data      []byte
	lostAt    time.Time // ordered mode: when the lost segment was sent (zero = not lost)
	later     int       // ordered mode: segments sent after the lost one (duplicate ACKs)
	fastSet   bool
	release   bool    // call Release after delivering this copy
	rtoMs     float64 // ordered mode: current retransmission timeout (doubles per lost retransmission)
	backedOff bool    // a retransmission was lost: recovered by RTO backoff, not fast retransmit
}

// itemHeap is a min-heap by (at, n) without container/heap, so pushing
// does not box an interface (no allocation per packet, P19).
type itemHeap []item

func (h itemHeap) less(i, j int) bool {
	if h[i].at.Equal(h[j].at) {
		return h[i].n < h[j].n
	}
	return h[i].at.Before(h[j].at)
}

func (h *itemHeap) push(it item) {
	*h = append(*h, it)
	a := *h
	i := len(a) - 1
	for i > 0 {
		p := (i - 1) / 2
		if !a.less(i, p) {
			break
		}
		a[i], a[p] = a[p], a[i]
		i = p
	}
}

func (h *itemHeap) pop() item {
	a := *h
	top := a[0]
	last := len(a) - 1
	a[0] = a[last]
	a[last] = item{}
	a = a[:last]
	i := 0
	for {
		l, r, m := 2*i+1, 2*i+2, i
		if l < len(a) && a.less(l, m) {
			m = l
		}
		if r < len(a) && a.less(r, m) {
			m = r
		}
		if m == i {
			break
		}
		a[i], a[m] = a[m], a[i]
		i = m
	}
	*h = a
	return top
}

// Link delays packets in one direction and hands them to Deliver in release
// order, from a single goroutine.
//
// Ordered=false models datagrams (WebTransport): loss drops, jitter does not
// reorder unless ReorderPct says so, and duplicates are possible.
//
// Ordered=true models a TCP stream (WebSocket), simulated: packets leave in
// send order, a lost segment is retransmitted and every packet behind it waits
// (head-of-line blocking). Recovery is whichever comes first:
//   - fast retransmit: the 3rd segment sent after the lost one produces the 3rd
//     duplicate ACK; delivery = that send time + RTT + one-way delay;
//   - retransmission timeout (Linux-style, RFC 6298 with a 200 ms floor on the
//     variance term): RTO = RTT + max(4·jitter, 200 ms); delivery = lost send
//     time + RTO + one-way delay.
//
// RTT = this link's delay + the reverse link's delay (SetReverseDelay). The
// retransmission itself is assumed not lost. Duplication and reordering do
// not exist on a TCP stream and are ignored in this mode.
type Link struct {
	Deliver func([]byte)
	// Release, when set, is called once per pushed packet after its last
	// delivery or its drop, so the caller can return pooled buffers.
	Release func([]byte)
	Ordered bool

	mu         sync.Mutex
	p          Params
	revDelayMs float64
	q          itemHeap // datagram mode
	fifo       []item   // ordered mode
	n          uint64
	last       time.Time
	wake       chan struct{}
	closed     bool
	rng        *rand.Rand
	stats      Stats
	due        []item // reused by run
}

func NewLink(p Params, ordered bool, seed uint64, deliver func([]byte)) *Link {
	l := &Link{Deliver: deliver, Ordered: ordered, p: p.Clamp(), revDelayMs: p.Clamp().DelayMs,
		wake: make(chan struct{}, 1), rng: rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15))}
	go l.run()
	return l
}

func (l *Link) Params() Params {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.p
}

func (l *Link) SetParams(p Params) {
	l.mu.Lock()
	l.p = p.Clamp()
	l.mu.Unlock()
}

// SetReverseDelay tells an ordered link the other direction's delay, for RTT.
func (l *Link) SetReverseDelay(ms float64) {
	l.mu.Lock()
	l.revDelayMs = ms
	l.mu.Unlock()
}

func (l *Link) Stats() Stats {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.stats
}

// Closed reports whether Close was called.
func (l *Link) Closed() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.closed
}

func (l *Link) Close() {
	l.mu.Lock()
	l.closed = true
	l.mu.Unlock()
	l.signal()
}

func (l *Link) signal() {
	select {
	case l.wake <- struct{}{}:
	default:
	}
}

func ms(v float64) time.Duration { return time.Duration(v * float64(time.Millisecond)) }

// Push queues a packet. The link keeps the slice until Release.
func (l *Link) Push(data []byte) {
	now := time.Now()
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		l.release(data)
		return
	}
	p := l.p
	l.stats.In++
	delay := p.DelayMs
	if p.JitterMs > 0 {
		delay += (l.rng.Float64()*2 - 1) * p.JitterMs
	}
	at := now.Add(ms(max(delay, 0)))
	lost := p.LossPct > 0 && l.rng.Float64()*100 < p.LossPct
	if l.Ordered {
		l.pushOrdered(now, at, lost, data)
		l.mu.Unlock()
		l.signal()
		return
	}
	if lost {
		l.stats.Dropped++
		l.mu.Unlock()
		l.release(data)
		return
	}
	reorder := p.ReorderPct > 0 && l.rng.Float64()*100 < p.ReorderPct
	if reorder {
		at = at.Add(ms(10 + p.JitterMs + l.rng.Float64()*20)) // held back so later packets overtake it
		l.stats.Reordered++
	} else {
		if at.Before(l.last) { // jitter alone does not reorder (like most real paths)
			at = l.last
		}
		l.last = at
	}
	dup := p.DupPct > 0 && l.rng.Float64()*100 < p.DupPct
	l.n++
	if dup {
		l.stats.Duplicated++
		l.q.push(item{at: at, n: l.n, data: data})
		l.n++
		l.q.push(item{at: at.Add(ms(l.rng.Float64() * (p.JitterMs + 2))), n: l.n, data: data, release: true})
	} else {
		l.q.push(item{at: at, n: l.n, data: data, release: true})
	}
	l.mu.Unlock()
	l.signal()
}

func (l *Link) pushOrdered(now, at time.Time, lost bool, data []byte) {
	p := l.p
	rtt := p.DelayMs + l.revDelayMs
	// Every queued lost segment sees one more duplicate ACK.
	for i := range l.fifo {
		it := &l.fifo[i]
		if it.lostAt.IsZero() || it.fastSet {
			continue
		}
		it.later++
		if it.later == 3 {
			fast := now.Add(ms(rtt + p.DelayMs))
			if fast.Before(it.at) {
				it.at, it.fastSet = fast, true
			}
		}
	}
	l.n++
	it := item{at: at, n: l.n, data: data, release: true}
	if lost {
		rto := rtt + max(4*p.JitterMs, 200)
		it.lostAt = now
		it.rtoMs = rto
		it.at = now.Add(ms(rto + p.DelayMs))
		l.stats.Retransmitted++
	}
	l.fifo = append(l.fifo, it)
}

func (l *Link) release(b []byte) {
	if l.Release != nil {
		l.Release(b)
	}
}

func (l *Link) run() {
	timer := time.NewTimer(time.Hour)
	for {
		l.mu.Lock()
		if l.closed {
			for _, it := range l.fifo {
				if it.release {
					l.release(it.data)
				}
			}
			for _, it := range l.q {
				if it.release {
					l.release(it.data)
				}
			}
			l.fifo, l.q = nil, nil
			l.mu.Unlock()
			return
		}
		now := time.Now()
		due := l.due[:0]
		wait := time.Hour
		if l.Ordered {
			// FIFO: the head blocks everything behind it.
			for len(l.fifo) > 0 && !l.fifo[0].at.After(now) {
				it := l.fifo[0]
				// The retransmission itself crosses the same path: it is lost
				// with the current loss rate (an outage loses every one), and
				// TCP then doubles the RTO (backoff, capped at 2 s).
				if !it.lostAt.IsZero() && l.p.LossPct > 0 && l.rng.Float64()*100 < l.p.LossPct {
					l.fifo[0].rtoMs = min(2000, it.rtoMs*2)
					l.fifo[0].at = now.Add(ms(l.fifo[0].rtoMs + l.p.DelayMs))
					l.fifo[0].fastSet = true // later dup ACKs do not trigger another fast retransmit
					l.fifo[0].backedOff = true
					l.stats.Retransmitted++
					l.stats.Backoffs++
					break
				}
				if !it.lostAt.IsZero() {
					if it.fastSet && !it.backedOff {
						l.stats.FastRetransmits++
					} else {
						l.stats.RTOs++
					}
					stall := float64(it.at.Sub(it.lostAt).Microseconds())/1000 - l.p.DelayMs
					l.stats.MaxStallMs = max(l.stats.MaxStallMs, stall)
				}
				due = append(due, it)
				// Shift down instead of re-slicing, so the backing array is
				// reused and appends do not reallocate (the queue is short).
				n := copy(l.fifo, l.fifo[1:])
				l.fifo[n] = item{}
				l.fifo = l.fifo[:n]
			}
			if len(l.fifo) > 0 {
				wait = l.fifo[0].at.Sub(now)
			}
		} else {
			for len(l.q) > 0 && !l.q[0].at.After(now) {
				due = append(due, l.q.pop())
			}
			if len(l.q) > 0 {
				wait = l.q[0].at.Sub(now)
			}
		}
		l.mu.Unlock()
		for i := range due {
			l.Deliver(due[i].data)
			if due[i].release {
				l.release(due[i].data)
			}
			due[i] = item{}
		}
		if len(due) > 0 {
			// Counted after the callbacks, so Delivered never runs ahead of them.
			l.mu.Lock()
			l.stats.Delivered += uint64(len(due))
			l.mu.Unlock()
		}
		l.due = due[:0]
		if len(due) > 0 {
			continue
		}
		timer.Reset(wait)
		select {
		case <-timer.C:
		case <-l.wake:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		}
	}
}
