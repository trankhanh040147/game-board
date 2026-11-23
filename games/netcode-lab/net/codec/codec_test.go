package codec

import (
	"reflect"
	"testing"

	"netcodelab/sim"
)

func roundTrip(t *testing.T, b []byte) (Header, *Reader) {
	t.Helper()
	r := &Reader{B: b}
	h := r.Header()
	if r.Err != nil {
		t.Fatal(r.Err)
	}
	return h, r
}

func TestInputRoundTrip(t *testing.T) {
	in := Input{Cmds: []sim.Cmd{
		{Seq: 40, ClientTick: 1000, In: sim.Input{Buttons: sim.BtnForward, Yaw: -1234, Pitch: 77}},
		{Seq: 41, ClientTick: 1001, In: sim.Input{Buttons: sim.BtnForward | sim.BtnFire, Yaw: 32767, Pitch: -32768},
			RenderTick: 993, RenderFrac: 40000, SubtickFrac: 123},
		{Seq: 42, ClientTick: 1002, In: sim.Input{Buttons: sim.BtnJump}},
	}}
	var w Writer
	AppendInput(&w, Header{Seq: 7, Ack: 65535, AckBits: 0xdeadbeef}, &in)
	h, r := roundTrip(t, w.B)
	if h != (Header{TInput, 7, 65535, 0xdeadbeef}) {
		t.Fatalf("header %+v", h)
	}
	var out Input
	ReadInput(r, &out)
	if r.Err != nil || r.Off != len(w.B) || !reflect.DeepEqual(in.Cmds, out.Cmds) {
		t.Fatalf("err=%v off=%d/%d\n in=%+v\nout=%+v", r.Err, r.Off, len(w.B), in.Cmds, out.Cmds)
	}
	// Fire fields are present only when fire is pressed: 3 cmds = 1 + 9 + 3*14 + 8.
	if want := HeaderSize + 1 + 3*14 + 8; len(w.B) != want {
		t.Fatalf("size %d want %d", len(w.B), want)
	}
}

func TestInputKeepsNewestFour(t *testing.T) {
	var in Input
	for i := uint32(1); i <= 6; i++ {
		in.Cmds = append(in.Cmds, sim.Cmd{Seq: i})
	}
	var w Writer
	AppendInput(&w, Header{}, &in)
	_, r := roundTrip(t, w.B)
	var out Input
	ReadInput(r, &out)
	if len(out.Cmds) != 4 || out.Cmds[0].Seq != 3 || out.Cmds[3].Seq != 6 {
		t.Fatalf("%+v", out.Cmds)
	}
}

func TestSnapshotRoundTrip(t *testing.T) {
	s := Snapshot{
		ServerTick: 123456, ServerTimeMs: 98765.4321, LastProcessedInputSeq: 41,
		Own: OwnState{State: sim.State{Pos: [3]int32{-5, 0, 1 << 20}, Vel: [3]int32{1, -2, 3}, OnGround: true, Yaw: -9, Pitch: 9},
			Health: 75, InputBuffer: 2, Starved: 65535, InputLead: -3, Dead: true, Life: 9},
		Entities: []Entity{{ID: 3, Team: 1, Pos: [3]int32{1, 2, 3}, Yaw: 4, Pitch: 5, Health: 100, Anim: AnimMoving | AnimOnGround}},
		Events:   []Event{{Type: 9, Data: []byte{1, 2, 3}}},
	}
	var w Writer
	AppendSnapshot(&w, Header{Seq: 1}, &s)
	h, r := roundTrip(t, w.B)
	var out Snapshot
	ReadSnapshot(r, &out)
	if h.Type != TSnapshot || r.Err != nil || r.Off != len(w.B) || !reflect.DeepEqual(s, out) {
		t.Fatalf("err=%v\n in=%+v\nout=%+v", r.Err, s, out)
	}
}

func TestPingPongAckDebugRoundTrip(t *testing.T) {
	var w Writer
	p := Pong{ClientSendMs: 1.5, ServerRecvMs: 2.25, ServerSendMs: 2.5, ServerTick: 9, TickFrac: 32768, TickRate: 64}
	AppendPong(&w, Header{}, &p)
	_, r := roundTrip(t, w.B)
	var po Pong
	ReadPong(r, &po)
	if po != p || r.Off != len(w.B) {
		t.Fatalf("%+v", po)
	}
	w.B = w.B[:0]
	AppendPing(&w, Header{}, &Ping{ClientSendMs: 3.75})
	_, r = roundTrip(t, w.B)
	var pi Ping
	ReadPing(r, &pi)
	if pi.ClientSendMs != 3.75 {
		t.Fatal(pi)
	}
	w.B = w.B[:0]
	AppendSnapshotAck(&w, Header{}, &SnapshotAck{BaselineID: 4, ServerTick: 77})
	_, r = roundTrip(t, w.B)
	var a SnapshotAck
	ReadSnapshotAck(r, &a)
	if a != (SnapshotAck{4, 77}) {
		t.Fatal(a)
	}
	w.B = w.B[:0]
	d := Debug{ServerTick: 5, Players: []DebugPos{{ID: 1, Pos: [3]int32{-1, 2, -3}}}}
	AppendDebug(&w, Header{}, &d)
	_, r = roundTrip(t, w.B)
	var do Debug
	ReadDebug(r, &do)
	if !reflect.DeepEqual(d, do) {
		t.Fatal(do)
	}
}

func TestTruncatedPacketsError(t *testing.T) {
	var w Writer
	AppendSnapshot(&w, Header{}, &Snapshot{Entities: []Entity{{ID: 1}}})
	for n := HeaderSize; n < len(w.B); n++ {
		r := &Reader{B: w.B[:n]}
		r.Header()
		var s Snapshot
		ReadSnapshot(r, &s)
		if r.Err == nil {
			t.Fatalf("truncated at %d decoded without error", n)
		}
	}
}

func TestAckEndpoint(t *testing.T) {
	var a, b Endpoint
	// a sends 40 packets; b receives all but #5 and #6 (lost) and gets #7 twice.
	for i := 1; i <= 40; i++ {
		h := a.NextHeader(TInput, float64(i))
		if i == 5 || i == 6 {
			continue
		}
		b.OnReceive(h, float64(i))
		if i == 7 {
			if dup, _ := b.OnReceive(h, float64(i)); !dup {
				t.Fatal("duplicate not detected")
			}
		}
	}
	bs := b.Snapshot()
	if bs.Received != 38 || bs.Duplicates != 1 || bs.RemoteGaps != 2 {
		t.Fatalf("b stats %+v", bs)
	}
	// b replies once; its ack header covers a's 33 most recent seqs (8..40).
	a.OnReceive(b.NextHeader(TSnapshot, 50), 50)
	as := a.Snapshot()
	if as.Acked != 33 {
		t.Fatalf("acked %d want 33", as.Acked)
	}
	// Sends 1..7 fell out of the window; 1-4 and 7 were received but never acked,
	// so from a's point of view all 7 are lost (it cannot know otherwise).
	if as.Lost != 7 {
		t.Fatalf("lost %d want 7", as.Lost)
	}
	if as.RTTMs <= 0 {
		t.Fatal("no rtt")
	}
}

func TestSeqGreaterWraps(t *testing.T) {
	if !SeqGreater(1, 65535) || SeqGreater(65535, 1) || !SeqGreater(100, 99) {
		t.Fatal("wrap logic")
	}
}

func TestEventsAndClaimRoundTrip(t *testing.T) {
	sr := ShotResult{ShotSeq: 41, ResolveTick: 1000, RenderTick: 990, RenderFrac: 123, RewoundTick: 990, RewoundFrac: 123,
		Flags: ShotLagComp | ShotKilled, HitID: 3, Hitbox: 2, Damage: 100, VictimHP: 0, SeenID: 3, SeenHitbox: 2, MovedCm: 77,
		SeenPos: [3]int32{1, 2, 3}, UsedPos: [3]int32{-4, 5, -6}, WallDistCm: 4321, RecvMs: 12.5, TickStartMs: 13.25, SubtickFrac: 999, TimingErrUs: 7812}
	r := &Reader{B: sr.Append(nil)}
	var sr2 ShotResult
	sr2.Read(r)
	if sr2 != sr || r.Off != len(r.B) || r.Err != nil {
		t.Fatalf("%+v", sr2)
	}
	if len(r.B) > 255 {
		t.Fatal("event too big for u8 length")
	}
	d := Damage{ShotSeq: 41, ShooterID: 2, Hitbox: 1, Damage: 25, Health: 75, ResolveTick: 1000, Flags: 1}
	r = &Reader{B: d.Append(nil)}
	var d2 Damage
	d2.Read(r)
	if d2 != d || r.Off != len(r.B) {
		t.Fatal(d2)
	}
	de := Death{Life: 3, ShooterID: 2, Hitbox: 2, Flags: 1, ShotSeq: 9, ResolveTick: 10, RewoundTick: 8, RewoundFrac: 5,
		HitPos: [3]int32{1, 2, 3}, NowPos: [3]int32{4, 5, 6}, ShooterPos: [3]int32{7, 8, 9}, ShooterYaw: -5, ShooterPitch: 6, RespawnTick: 200}
	r = &Reader{B: de.Append(nil)}
	var de2 Death
	de2.Read(r)
	if de2 != de || r.Off != len(r.B) {
		t.Fatal(de2)
	}
	var w Writer
	c := Claim{InputSeq: 5, ClientTick: 6, Pos: [3]int32{7, -8, 9}, VictimID: 4, Hitbox: 2}
	AppendClaim(&w, Header{}, &c)
	h, rr := roundTrip(t, w.B)
	var c2 Claim
	ReadClaim(rr, &c2)
	if h.Type != TClaim || c2 != c || rr.Off != len(w.B) {
		t.Fatal(c2)
	}
}
