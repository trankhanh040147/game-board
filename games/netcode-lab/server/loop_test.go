package server

import (
	"io"
	"log/slog"
	"sync"
	"testing"

	"netcodelab/net/cond"
	"netcodelab/sim"
)

type capture struct {
	mu  sync.Mutex
	got [][]byte
}

func (c *capture) deliver(b []byte) {
	c.mu.Lock()
	c.got = append(c.got, append([]byte(nil), b...))
	c.mu.Unlock()
}

func loopRoom(t testing.TB, n int, deliver func([]byte)) *Room {
	r := NewRoom(slog.New(slog.NewTextHandler(io.Discard, nil)), "x")
	for i := 1; i <= n; i++ {
		c := testClient(r, uint8(i), uint8(i%2), [3]sim.Fx{sim.FromFloat(float64(i)), 0, sim.FromFloat(float64(-i))})
		c.down.Close()
		c.down = cond.NewLink(cond.Params{}, false, uint64(i), deliver)
		c.down.Release = r.pool.put
	}
	return r
}

// P19: both loops put the same bytes on the wire (headers differ only in seq).
func TestLoopModesSameBytes(t *testing.T) {
	var a, b capture
	ra := loopRoom(t, 6, a.deliver)
	rb := loopRoom(t, 6, b.deliver)
	sa, sb := DefaultSettings(), DefaultSettings()
	sa.TruthGhost, sb.TruthGhost = true, true
	sb.Loop = "naive"
	for tick := uint32(1); tick <= 20; tick++ {
		ra.mu.Lock()
		ra.sendSnapshots(tick, sa, float64(tick))
		ra.mu.Unlock()
		rb.mu.Lock()
		rb.sendSnapshots(tick, sb, float64(tick))
		rb.mu.Unlock()
	}
	waitFor := func(c *capture, n int) {
		for i := 0; i < 200; i++ {
			c.mu.Lock()
			l := len(c.got)
			c.mu.Unlock()
			if l >= n {
				return
			}
			sleepMs(2)
		}
		t.Fatalf("got fewer than %d packets", n)
	}
	waitFor(&a, 240)
	waitFor(&b, 240)
	// Order across clients follows map iteration, so compare as multisets.
	count := map[string]int{}
	for _, p := range a.got {
		count[string(p)]++
	}
	for _, p := range b.got {
		count[string(p)]--
	}
	for k, v := range count {
		if v != 0 {
			for k2, v2 := range count {
				if v2 == -v && len(k2) == len(k) {
					for i := range k {
						if k[i] != k2[i] {
							t.Logf("first differing byte %d: %d vs %d (type %d)", i, k[i], k2[i], k[0])
							break
						}
					}
					break
				}
			}
			t.Fatalf("byte streams differ (%d) for a %d-byte packet, type %d", v, len(k), k[0])
		}
	}
}

// P19: allocations per snapshot tick, zero-alloc loop vs naive loop.
func TestLoopModesAllocations(t *testing.T) {
	measure := func(loop string) float64 {
		r := loopRoom(t, 20, func([]byte) {})
		s := DefaultSettings()
		s.Loop = loop
		tick := uint32(0)
		warm := func() {
			tick++
			r.mu.Lock()
			r.sendSnapshots(tick, s, float64(tick))
			r.hist.record(tick, 0, r.clients, loop == "naive")
			r.mu.Unlock()
			// Real ticks are >= 7.8 ms apart; let the link goroutines deliver
			// and release the pooled buffers, as they do in the server.
			waitDrained(r)
		}
		for i := 0; i < 600; i++ { // past the 512-slot history ring's first fill
			warm()
		}
		sleepMs(20)
		return testing.AllocsPerRun(200, warm)
	}
	za, nv := measure("zeroalloc"), measure("naive")
	t.Logf("allocs per snapshot tick, 20 clients: zeroalloc %.1f, naive %.1f", za, nv)
	if za > 2 || nv < 40 {
		t.Fatalf("zeroalloc %.1f (want <= 2), naive %.1f (want >= 40)", za, nv)
	}
}

func sleepMs(n int) { <-timeAfter(n) }

func waitDrained(r *Room) {
	for i := 0; i < 1000; i++ {
		done := true
		for _, c := range r.clients {
			st := c.down.Stats()
			if st.Delivered+st.Dropped < st.In {
				done = false
			}
		}
		if done {
			return
		}
		runtimeGosched()
	}
}
