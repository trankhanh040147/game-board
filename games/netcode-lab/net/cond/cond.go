// Package cond is the in-process network conditioner (B.2): per client and
// per direction it adds delay, jitter, loss, duplication and reordering.
// On a LAN (~1 ms RTT) it is what makes the default experience match A.1.
package cond

import (
	"container/heap"
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
	In            uint64 `json:"in"`
	Delivered     uint64 `json:"delivered"`
	Dropped       uint64 `json:"dropped"`
	Duplicated    uint64 `json:"duplicated"`
	Reordered     uint64 `json:"reordered"`
	Retransmitted uint64 `json:"retransmitted"` // ordered mode: loss turned into a retransmit stall
}

type item struct {
	at   time.Time
	n    uint64
	data []byte
}

type pq []item

func (q pq) Len() int { return len(q) }
func (q pq) Less(i, j int) bool {
	if q[i].at.Equal(q[j].at) {
		return q[i].n < q[j].n
	}
	return q[i].at.Before(q[j].at)
}
func (q pq) Swap(i, j int) { q[i], q[j] = q[j], q[i] }
func (q *pq) Push(x any)   { *q = append(*q, x.(item)) }
func (q *pq) Pop() any {
	o := *q
	it := o[len(o)-1]
	*q = o[:len(o)-1]
	return it
}

// Link delays packets in one direction and hands them to Deliver in release
// order, from a single goroutine.
//
// Ordered=true models a TCP stream (WebSocket mode): nothing is reordered or
// duplicated, and a "lost" packet is retransmitted after an RTO, blocking every
// packet behind it (head-of-line blocking, simulated). Ordered=false models
// datagrams: loss drops the packet.
type Link struct {
	Deliver func([]byte)
	Ordered bool

	mu     sync.Mutex
	p      Params
	q      pq
	n      uint64
	last   time.Time
	wake   chan struct{}
	closed bool
	rng    *rand.Rand
	stats  Stats
}

func NewLink(p Params, ordered bool, seed uint64, deliver func([]byte)) *Link {
	l := &Link{Deliver: deliver, Ordered: ordered, p: p.Clamp(), wake: make(chan struct{}, 1),
		rng: rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15))}
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

func (l *Link) Stats() Stats {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.stats
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

// Push queues a packet. The link keeps the slice; callers must not reuse it.
func (l *Link) Push(data []byte) {
	now := time.Now()
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
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
		if lost {
			// RTO: Linux floor is 200 ms, plus the round trip of the retransmit.
			at = at.Add(ms(200 + 2*p.DelayMs))
			l.stats.Retransmitted++
		}
		if at.Before(l.last) {
			at = l.last
		}
		l.last = at
		l.enqueue(at, data)
	} else {
		if lost {
			l.stats.Dropped++
			l.mu.Unlock()
			return
		}
		reorder := p.ReorderPct > 0 && l.rng.Float64()*100 < p.ReorderPct
		if reorder {
			// Held back so later packets overtake it.
			at = at.Add(ms(10 + p.JitterMs + l.rng.Float64()*20))
			l.stats.Reordered++
		} else {
			// Jitter alone does not reorder (like most real paths).
			if at.Before(l.last) {
				at = l.last
			}
			l.last = at
		}
		l.enqueue(at, data)
		if p.DupPct > 0 && l.rng.Float64()*100 < p.DupPct {
			l.stats.Duplicated++
			l.enqueue(at.Add(ms(l.rng.Float64()*(p.JitterMs+2))), data)
		}
	}
	l.mu.Unlock()
	l.signal()
}

func (l *Link) enqueue(at time.Time, data []byte) {
	l.n++
	heap.Push(&l.q, item{at: at, n: l.n, data: data})
}

func (l *Link) run() {
	timer := time.NewTimer(time.Hour)
	for {
		l.mu.Lock()
		if l.closed {
			l.mu.Unlock()
			return
		}
		var due [][]byte
		now := time.Now()
		for len(l.q) > 0 && !l.q[0].at.After(now) {
			due = append(due, heap.Pop(&l.q).(item).data)
		}
		wait := time.Hour
		if len(l.q) > 0 {
			wait = l.q[0].at.Sub(now)
		}
		l.stats.Delivered += uint64(len(due))
		l.mu.Unlock()
		for _, d := range due {
			l.Deliver(d)
		}
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
