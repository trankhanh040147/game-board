package clock

import (
	"math"
	"testing"

	"netcodelab/net/codec"
)

func TestOffsetAndTick(t *testing.T) {
	var s Sync
	// Server clock = client clock + 1000 ms; 20 ms each way; server at 64 Hz.
	const off, oneWay = 1000.0, 20.0
	for i := 0; i < 10; i++ {
		send := float64(i * 100)
		extra := 0.0
		if i%3 == 0 {
			extra = 30 // a slow sample on the uplink; must be filtered out
		}
		recv := send + oneWay + extra + off
		p := codec.Pong{ClientSendMs: send, ServerRecvMs: recv, ServerSendMs: recv + 0.1,
			ServerTick: uint32(recv * 64 / 1000), TickFrac: uint16(math.Mod(recv*64/1000, 1) * 65536), TickRate: 64}
		s.OnPong(p, recv+0.1-off+oneWay)
	}
	e := s.Estimate()
	if math.Abs(e.OffsetMs-off) > 0.5 || math.Abs(e.MinRTTMs-40) > 0.01 {
		t.Fatalf("%+v", e)
	}
	now := 5000.0
	want := (now + off) * 64 / 1000
	if got := s.ServerTick(now); math.Abs(got-want) > 0.05 {
		t.Fatalf("tick %f want %f", got, want)
	}
}

// On a calm host a stall's margin raise drains back to 1 tick within seconds,
// and a starvation in the first second of a session still raises it.
func TestPacerMarginRaisesAndDrains(t *testing.T) {
	p := NewPacer()
	p.OnServerFeedback(0, 0)
	p.OnServerFeedback(1, 500) // first second of the session
	if p.Margin != 2 {
		t.Fatalf("first-second starvation must raise: %v", p.Margin)
	}
	p.OnServerFeedback(2, 900) // same burst: no second raise
	if p.Margin != 2 {
		t.Fatalf("burst raised twice: %v", p.Margin)
	}
	now := 900.0
	for i := uint16(3); i < 7; i++ { // four more stalls, 1.5 s apart
		now += 1500
		p.OnServerFeedback(i, now)
	}
	if p.Margin != 6 {
		t.Fatalf("margin %v want 6", p.Margin)
	}
	stallEnd := now
	for p.Margin > 1 && now-stallEnd < 60000 {
		now += 50 // a snapshot every 50 ms, no starvation
		p.OnServerFeedback(6, now)
	}
	if took := now - stallEnd; p.Margin != 1 || took > 8000 {
		t.Fatalf("margin %v after %.0f ms; want 1 within 8 s", p.Margin, took)
	}
}

// A host that needs 2 ticks: the server starves whenever the margin is below
// 2. The pacer must settle at 2 instead of draining to 1 and re-starving
// every few seconds (bots' check 2 observation, 2026-11-23).
func TestPacerDoesNotOscillate(t *testing.T) {
	p := NewPacer()
	starved := uint16(0)
	p.OnServerFeedback(starved, 0)
	raisesAfter10s := 0
	for now := 50.0; now < 120000; now += 50 {
		if p.Margin < 2 && int(now)%500 == 0 {
			starved++
		}
		before := p.Adjustments
		p.OnServerFeedback(starved, now)
		if now > 10000 && p.Adjustments > before {
			raisesAfter10s++
		}
	}
	if raisesAfter10s > 4 || p.Margin < 2 {
		t.Fatalf("margin %v, %d raises after 10 s (oscillating)", p.Margin, raisesAfter10s)
	}
	t.Logf("margin %v, %d raises after the first 10 s of 120 s", p.Margin, raisesAfter10s)
}
