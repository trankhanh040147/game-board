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
	time.Sleep(80 * time.Millisecond)
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
	time.Sleep(100 * time.Millisecond)
	st := l.Stats()
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
	time.Sleep(260 * time.Millisecond)
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.got) != 2 || s.got[0] != 0 || s.got[1] != 1 {
		t.Fatalf("got %v", s.got)
	}
	if d := s.at[1].Sub(start); d < 200*time.Millisecond {
		t.Fatalf("packet behind a retransmit arrived after %v, want >= 200ms (head-of-line)", d)
	}
}
