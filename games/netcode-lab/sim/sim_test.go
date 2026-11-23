package sim

import (
	"math"
	"testing"
)

func spawnState(m *Map) State {
	return State{Pos: m.Spawn("blue", 0), OnGround: true}
}

func TestSinCosTable(t *testing.T) {
	for a := -32768; a < 32768; a += 97 {
		want := math.Sin(AngleToRadians(int16(a)))
		got := ToFloat(Sin(int16(a)))
		if math.Abs(got-want) > 0.002 {
			t.Fatalf("sin(%d)=%f want %f", a, got, want)
		}
		if math.Abs(ToFloat(Cos(int16(a)))-math.Cos(AngleToRadians(int16(a)))) > 0.002 {
			t.Fatalf("cos(%d)", a)
		}
	}
}

func TestCourtyardLoads(t *testing.T) {
	m := Courtyard()
	if m.Name != "Courtyard" || len(m.Boxes) < 10 || len(m.Spawns["blue"]) == 0 || len(m.Spawns["orange"]) == 0 {
		t.Fatalf("unexpected map: %+v", m)
	}
}

func TestWalkForwardReachesMaxSpeedAndFacesMinusZ(t *testing.T) {
	m := Courtyard()
	p := DefaultParams()
	s := spawnState(m)
	z0 := s.Pos[2]
	for i := 0; i < 64; i++ { // 1 s
		Step(m, &s, Input{Buttons: BtnForward}, DtForRate(64), &p)
	}
	if !s.OnGround {
		t.Fatal("should stay on the ground")
	}
	if s.Pos[2] >= z0 || s.Pos[0] != m.Spawn("blue", 0)[0] {
		t.Fatalf("yaw 0 + W must move along -Z only, got %v", s.Pos)
	}
	speed := ToFloat(Length2(s.Vel[0], s.Vel[2]))
	if speed < 6.5 || speed > 7.01 {
		t.Fatalf("speed after 1 s = %.3f, want ~7", speed)
	}
	for i := 0; i < 64; i++ {
		Step(m, &s, Input{}, DtForRate(64), &p)
	}
	if s.Vel[0] != 0 || s.Vel[2] != 0 {
		t.Fatalf("friction should stop the player, vel=%v", s.Vel)
	}
}

func TestWallBlocksAndJumpLands(t *testing.T) {
	m := Courtyard()
	p := DefaultParams()
	// Stand south of the low wall (z max 0.4) and walk north into it.
	s := State{Pos: [3]Fx{0, 0, FromFloat(3)}, OnGround: true}
	for i := 0; i < 128; i++ {
		Step(m, &s, Input{Buttons: BtnForward}, DtForRate(64), &p)
	}
	if got := s.Pos[2] - HalfWidth; got != FromFloat(0.4) {
		t.Fatalf("player front should rest on the wall face 0.4, got %.4f", ToFloat(got))
	}
	Step(m, &s, Input{Buttons: BtnJump}, DtForRate(64), &p)
	if s.OnGround || s.Vel[1] <= 0 {
		t.Fatal("jump should leave the ground")
	}
	peak := s.Pos[1]
	for i := 0; i < 128; i++ {
		Step(m, &s, Input{}, DtForRate(64), &p)
		peak = max(peak, s.Pos[1])
	}
	if !s.OnGround || s.Pos[1] != 0 {
		t.Fatalf("should land on the floor, y=%v", ToFloat(s.Pos[1]))
	}
	if h := ToFloat(peak); h < 0.9 || h > 1.2 {
		t.Fatalf("jump height %.3f, want ~1.05", h)
	}
}

// Same inputs, same rules: the predictor matches the server and never corrects.
func TestPredictorZeroCorrectionsWhenRulesMatch(t *testing.T) {
	m := Courtyard()
	dt := DtForRate(64)
	pr := NewPredictor(m, spawnState(m))
	server := spawnState(m)
	sp := DefaultParams()
	rng := uint32(1)
	var seq uint32
	for tick := 0; tick < 2000; tick++ {
		rng = rng*1664525 + 1013904223
		seq++
		c := Cmd{Seq: seq, In: Input{Buttons: uint16(rng>>24) & 0x1f, Yaw: int16(rng >> 8)}}
		pr.Predict(c, dt)
		// Server lags 3 inputs behind (40 ms RTT at 64 Hz).
		if seq > 3 {
			pending := pr.Pending()
			Step(m, &server, pending[0].In, dt, &sp)
			r := pr.Reconcile(server, pending[0].Seq, dt, true)
			if r.Corrected || r.Delta != [3]Fx{} {
				t.Fatalf("tick %d: unexpected correction %+v", tick, r)
			}
		}
	}
	if pr.Corrections != 0 || pr.Replayed == 0 {
		t.Fatalf("corrections=%d replayed=%d", pr.Corrections, pr.Replayed)
	}
}

// A server-only speed change must show up as a correction (A.7, A.14).
func TestPredictorDetectsServerOnlyModifier(t *testing.T) {
	m := Courtyard()
	dt := DtForRate(64)
	pr := NewPredictor(m, spawnState(m))
	server := spawnState(m)
	sp := DefaultParams()
	sp.SpeedScale = One / 2
	for seq := uint32(1); seq <= 10; seq++ {
		c := Cmd{Seq: seq, In: Input{Buttons: BtnForward}}
		pr.Predict(c, dt)
		Step(m, &server, c.In, dt, &sp)
		pr.Reconcile(server, seq, dt, true)
	}
	if pr.Corrections == 0 {
		t.Fatal("expected corrections")
	}
}
