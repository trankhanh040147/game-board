package duel

import (
	"math/rand/v2"
	"testing"
)

// bot input: holds a direction for a while, jumps and attacks sometimes.
type botIn struct {
	r   *rand.Rand
	cur uint8
}

func (b *botIn) next() uint8 {
	if b.r.IntN(20) == 0 {
		b.cur = []uint8{0, BtnLeft, BtnRight, BtnRight, BtnLeft}[b.r.IntN(5)]
	}
	v := b.cur
	if b.r.IntN(40) == 0 {
		v |= BtnJump
	}
	if b.r.IntN(25) == 0 {
		v |= BtnAttack
	}
	return v
}

type pkt struct {
	at float64
	b  []byte
}

// runPair runs two sessions over a simulated link with random one-way delay
// (ms) and returns them plus the per-peer input log.
func runPair(t *testing.T, mode Mode, delay int, minMs, maxMs float64, frames int, inject bool) (*Session, *Session, [2][]uint8) {
	t.Helper()
	ss := [2]*Session{NewSession(Config{Side: 0, Delay: delay, Mode: mode, Seed: 7}), NewSession(Config{Side: 1, Delay: delay, Mode: mode, Seed: 9})}
	r := rand.New(rand.NewPCG(1, 2))
	bots := [2]*botIn{{r: rand.New(rand.NewPCG(3, 4))}, {r: rand.New(rand.NewPCG(5, 6))}}
	var q [2][]pkt // q[i]: packets in flight to peer i
	var log [2][]uint8
	now := 0.0
	for i := range 2 {
		ss[i].Begin()
	}
	for slot := 0; ss[0].cur < int32(frames) || ss[1].cur < int32(frames); slot++ {
		if slot > frames*20 {
			t.Fatalf("no progress: %d %d", ss[0].cur, ss[1].cur)
		}
		now += FrameMs
		for i := range 2 {
			keep := q[i][:0]
			for _, p := range q[i] {
				if p.at <= now {
					if err := ss[i].Receive(p.b, now); err != nil {
						t.Fatal(err)
					}
				} else {
					keep = append(keep, p)
				}
			}
			q[i] = keep
		}
		for i := range 2 {
			if inject && i == 1 && slot == 200 {
				ss[i].Inject()
			}
			b := bots[i].next()
			ss[i].Tick(b, now)
			{
				q[1-i] = append(q[1-i], pkt{now + minMs + r.Float64()*(maxMs-minMs), ss[i].Packet(now)})
			}
		}
	}
	for i := range 2 {
		log[i] = ss[i].local[:]
	}
	return ss[0], ss[1], log
}

// The confirmed checksums of both peers match frame by frame, and they match
// a plain re-run of the sim with the inputs that were actually used.
func checkAgainstReplay(t *testing.T, a, b *Session, frames int) {
	t.Helper()
	s := New()
	for f := 0; f < frames; f++ {
		i := f % RingN
		Step(&s, [2]uint8{a.local[i], b.local[i]})
		if f >= frames-RingN+20 {
			if a.hashFrame[i] == int32(f) && a.hash[i] != s.Hash() {
				t.Fatalf("frame %d: peer 0 hash %x != replay %x", f, a.hash[i], s.Hash())
			}
			if b.hashFrame[i] == int32(f) && b.hash[i] != s.Hash() {
				t.Fatalf("frame %d: peer 1 hash %x != replay %x", f, b.hash[i], s.Hash())
			}
		}
	}
}

func TestRollbackMatchesReplay(t *testing.T) {
	const frames = 500
	for _, d := range []int{0, 1, 2} {
		a, b, _ := runPair(t, ModeRollback, d, 20, 60, frames, false)
		if a.desync != nil || b.desync != nil {
			t.Fatalf("D=%d desync %+v %+v", d, a.desync, b.desync)
		}
		sa, sb := a.Stats(), b.Stats()
		if sa.ChecksCompared < 300 || sb.ChecksCompared < 300 {
			t.Fatalf("D=%d too few checks compared: %d %d", d, sa.ChecksCompared, sb.ChecksCompared)
		}
		if d == 0 && sa.Rollbacks == 0 {
			t.Fatalf("D=0 with 20-60 ms one-way should roll back")
		}
		t.Logf("D=%d rollbacks %d/%d frames %d/%d maxdepth %d stalls %d/%d checks %d", d, sa.Rollbacks, sb.Rollbacks, sa.FramesRolledBack, sb.FramesRolledBack, sa.MaxDepth, sa.StallFrames, sb.StallFrames, sa.ChecksCompared)
	}
}

func TestLockstepNeverPredicts(t *testing.T) {
	a, b, _ := runPair(t, ModeLockstep, 2, 20, 60, 400, false)
	sa, sb := a.Stats(), b.Stats()
	if sa.Rollbacks != 0 || sb.Rollbacks != 0 {
		t.Fatal("lockstep rolled back")
	}
	if sa.StallFrames == 0 {
		t.Fatal("lockstep with D=2 under 20-60 ms one-way should stall")
	}
	if a.desync != nil || b.desync != nil {
		t.Fatal("desync")
	}
	t.Logf("lockstep D=2 stalls %d/%d", sa.StallFrames, sb.StallFrames)
}

func TestReplayEqualsSessions(t *testing.T) {
	const frames = 590
	a, b, _ := runPair(t, ModeRollback, 1, 10, 70, frames, false)
	checkAgainstReplay(t, a, b, frames)
}

func TestInjectIsCaught(t *testing.T) {
	a, b, _ := runPair(t, ModeRollback, 0, 20, 40, 500, true)
	if a.desync == nil || b.desync == nil {
		t.Fatalf("desync not caught: %+v %+v", a.desync, b.desync)
	}
	inj := b.Stats().InjectedAt
	if a.desync.Frame != inj || b.desync.Frame != inj {
		t.Fatalf("desync frame %d/%d, injected at %d", a.desync.Frame, b.desync.Frame, inj)
	}
}

func TestAutoDelay(t *testing.T) {
	for _, c := range []struct {
		rtt float64
		d   int
	}{{0, 0}, {99.9, 0}, {100, 1}, {199, 1}, {200, 2}, {400, 2}} {
		if AutoDelay(c.rtt) != c.d {
			t.Errorf("AutoDelay(%v)=%d want %d", c.rtt, AutoDelay(c.rtt), c.d)
		}
	}
}

func TestStateBytes(t *testing.T) {
	if StateBytes > 64 {
		t.Fatalf("state %d B > 64", StateBytes)
	}
}

// Mirrored fighters must turn to face each other in the same frame, whichever
// is processed first.
func TestFacingOrderIndependent(t *testing.T) {
	s := New()
	s.F[0].X, s.F[1].X = 400*Q, 400*Q+Q   // fighter 1 just right of 0
	s.F[0].Facing, s.F[1].Facing = -1, 1  // both face away
	Step(&s, [2]uint8{BtnRight, BtnLeft}) // they walk through each other's start X
	if s.F[0].Facing != 1 || s.F[1].Facing != -1 {
		t.Fatalf("facing %d %d, want 1 -1 (from start-of-frame positions)", s.F[0].Facing, s.F[1].Facing)
	}
}

// A lockstep peer whose opponent goes silent for longer than the ring (600
// slots) resumes in sync: no input slot in use is overwritten.
func TestLongLockstepStall(t *testing.T) {
	a := NewSession(Config{Side: 0, Delay: 2, Mode: ModeLockstep})
	b := NewSession(Config{Side: 1, Delay: 2, Mode: ModeLockstep})
	a.Begin()
	b.Begin()
	ba, bb := NewBotInput(1), NewBotInput(2)
	now := 0.0
	for slot := range 3000 {
		now += FrameMs
		a.Tick(ba.Next(), now)
		b.Tick(bb.Next(), now)
		silent := slot >= 300 && slot < 1300 // b's packets lost for 1000 slots
		if !silent {
			if err := a.Receive(b.Packet(now), now); err != nil {
				t.Fatal(err)
			}
		}
		if err := b.Receive(a.Packet(now), now); err != nil {
			t.Fatal(err)
		}
	}
	if a.desync != nil || b.desync != nil {
		t.Fatalf("desync after stall: %+v %+v", a.desync, b.desync)
	}
	if a.Stats().StallFrames < 900 || a.Stats().ChecksCompared < 1500 {
		t.Fatalf("stall %d checks %d", a.Stats().StallFrames, a.Stats().ChecksCompared)
	}
}
