package cond

import (
	"sync"
	"testing"
	"time"
)

type sink struct {
	mu  sync.Mutex
	got []int
	at  []time.Time
}

func (s *sink) deliver(b []byte) {
	s.mu.Lock()
	s.got = append(s.got, int(b[0])|int(b[1])<<8)
	s.at = append(s.at, time.Now())
	s.mu.Unlock()
}

func pkt(i int) []byte { return []byte{byte(i), byte(i >> 8)} }

func TestDelayAndOrder(t *testing.T) {
	var s sink
	l := NewLink(Params{DelayMs: 20, JitterMs: 5}, false, 1, s.deliver)
	defer l.Close()
	start := time.Now()
	for i := 0; i < 50; i++ {
		l.Push(pkt(i))
	}
	settle(t, l, 50)
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.got) != 50 {
		t.Fatalf("delivered %d", len(s.got))
	}
	for i, v := range s.got {
		if v != i {
			t.Fatalf("jitter must not reorder: %v", s.got)
		}
	}
	if d := s.at[0].Sub(start); d < 15*time.Millisecond {
		t.Fatalf("first packet after %v, want >= 15ms", d)
	}
}

func TestDatagramLossDropsAndReorders(t *testing.T) {
	var s sink
	l := NewLink(Params{LossPct: 20, ReorderPct: 10}, false, 2, s.deliver)
	defer l.Close()
	for i := 0; i < 2000; i++ {
		l.Push(pkt(i))
	}
	st := settle(t, l, 2000)
	if st.Dropped < 300 || st.Dropped > 500 || st.Reordered == 0 {
		t.Fatalf("stats %+v", st)
	}
	s.mu.Lock()
	n := len(s.got)
	s.mu.Unlock()
	if uint64(n) != 2000-st.Dropped {
		t.Fatalf("delivered %d dropped %d", n, st.Dropped)
	}
}

// Ordered (TCP-like) mode never drops: a "lost" packet stalls everything behind it.
func TestOrderedLossStalls(t *testing.T) {
	var s sink
	l := NewLink(Params{DelayMs: 1, LossPct: 100}, true, 3, s.deliver)
	defer l.Close()
	start := time.Now()
	l.Push(pkt(0))
	l.SetParams(Params{DelayMs: 1})
	l.Push(pkt(1))
	settle(t, l, 2)
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.got) != 2 || s.got[0] != 0 || s.got[1] != 1 {
		t.Fatalf("got %v", s.got)
	}
	if d := s.at[1].Sub(start); d < 200*time.Millisecond {
		t.Fatalf("packet behind a retransmit arrived after %v, want >= 200ms (head-of-line)", d)
	}
}

// TCP model: with a 20/s stream, the 3rd later segment triggers a fast
// retransmit before the RTO; everything sent meanwhile waits behind it.
func TestOrderedFastRetransmitBeatsRTO(t *testing.T) {
	var s sink
	l := NewLink(Params{DelayMs: 20, LossPct: 100}, true, 4, s.deliver)
	l.SetReverseDelay(20) // RTT 40
	defer l.Close()
	start := time.Now()
	l.Push(pkt(0)) // lost
	l.SetParams(Params{DelayMs: 20})
	for i := 1; i <= 4; i++ {
		time.Sleep(50 * time.Millisecond)
		l.Push(pkt(i))
	}
	settle(t, l, 5)
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.got) != 5 || s.got[0] != 0 || s.got[4] != 4 {
		t.Fatalf("order %v", s.got)
	}
	// 3rd later send at ~150 ms, + RTT 40 + delay 20 = ~210 ms; RTO would be 0 + 240 + 20 = 260 ms.
	d0 := s.at[0].Sub(start)
	if d0 < 195*time.Millisecond || d0 > 250*time.Millisecond {
		t.Fatalf("retransmit delivered after %v, want ~210 ms (fast retransmit)", d0)
	}
	for i := 1; i <= 3; i++ {
		if s.at[i].Before(s.at[0]) {
			t.Fatal("head-of-line blocking violated")
		}
	}
	st := l.Stats()
	if st.FastRetransmits != 1 || st.RTOs != 0 {
		t.Fatalf("stats %+v", st)
	}
}

func TestReleaseOncePerPush(t *testing.T) {
	var mu sync.Mutex
	rel := 0
	l := NewLink(Params{LossPct: 30, DupPct: 30}, false, 5, func([]byte) {})
	l.Release = func([]byte) { mu.Lock(); rel++; mu.Unlock() }
	for i := 0; i < 500; i++ {
		l.Push(pkt(i))
	}
	settle(t, l, 500)
	l.Close()
	for i := 0; i < 5000; i++ { // Release runs on the link goroutine
		mu.Lock()
		done := rel == 500
		mu.Unlock()
		if done {
			break
		}
		time.Sleep(time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if rel != 500 {
		t.Fatalf("released %d of 500", rel)
	}
}

// settle waits until every pushed packet is delivered or dropped (no fixed
// sleeps: a loaded host can be slower than any sleep, review V15).
func settle(t *testing.T, l *Link, pushed uint64) Stats {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		st := l.Stats()
		// Each duplicate adds one delivery beyond the pushed packet.
		if st.In == pushed && st.Delivered+st.Dropped >= pushed+st.Duplicated {
			return st
		}
		if time.Now().After(deadline) {
			t.Fatalf("packets still in flight after 10 s: %+v", st)
		}
		time.Sleep(time.Millisecond)
	}
}

// A 400 ms outage on a TCP-modelled link: retransmissions sent during the
// outage are lost too (RTO backoff), so nothing gets through until it ends.
func TestOrderedOutageBacksOff(t *testing.T) {
	var s sink
	l := NewLink(Params{DelayMs: 20}, true, 6, s.deliver)
	l.SetReverseDelay(20)
	defer l.Close()
	l.SetParams(Params{DelayMs: 20, LossPct: 100})
	start := time.Now()
	for i := 0; i < 8; i++ { // a 20/s stream during the outage
		l.Push(pkt(i))
		time.Sleep(50 * time.Millisecond)
	}
	l.SetParams(Params{DelayMs: 20}) // outage over at ~400 ms
	settle(t, l, 8)
	s.mu.Lock()
	defer s.mu.Unlock()
	if d := s.at[0].Sub(start); d < 400*time.Millisecond {
		t.Fatalf("first packet got through after %v, during the 400 ms outage", d)
	}
	for i, v := range s.got {
		if v != i {
			t.Fatalf("order %v", s.got)
		}
	}
	if st := l.Stats(); st.Backoffs == 0 {
		t.Fatalf("no backoff recorded: %+v", st)
	}
}
