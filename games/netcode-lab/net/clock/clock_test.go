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
