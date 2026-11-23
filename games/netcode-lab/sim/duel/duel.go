// Package duel is the deterministic 2D duel used by the A.13 mini-mode
// (rollback, input delay, lockstep, desync). Everything is integer math, so
// native and WASM builds give the same state on every frame.
//
// Units: 1 px = 256 subunits (Q8). The stage is StageW px wide, the ground is
// y = 0, y grows upward. One frame is 1/60 s.
package duel

const (
	Hz = 60
	Q  = 256 // subunits per px

	BtnLeft   uint8 = 1
	BtnRight  uint8 = 2
	BtnJump   uint8 = 4
	BtnAttack uint8 = 8

	StageW = 800 * Q
	W      = 40 * Q // fighter width
	H      = 80 * Q // fighter height
	Walk   = 3 * Q  // px per frame
	JumpV  = 14 * Q
	Grav   = 3 * Q / 4
	MaxHP  = 100

	AtkStartup = 5  // frames before the hitbox appears
	AtkActive  = 4  // frames the hitbox is live
	AtkTotal   = 19 // startup + active + recovery
	AtkReach   = 50 * Q
	AtkLow     = 30 * Q // hitbox y range above the feet
	AtkHigh    = 60 * Q
	Damage     = 8
	StunFrames = 18
	Knock      = 4 * Q
	KOPause    = 90
)

// Fighter is one player's state.
type Fighter struct {
	X, Y, VX, VY int32
	HP           int16
	Facing       int8  // -1 left, +1 right
	Atk          uint8 // 0 idle, else frames since the attack began
	Hit          uint8 // 1 once the current attack connected
	Stun         uint8 // hitstun frames left
	Prev         uint8 // last frame's buttons (attack fires on press)
}

// State is the whole duel. Encode gives StateBytes bytes.
type State struct {
	Frame int32
	KO    uint8 // frames left in the KO pause
	Score [2]uint8
	F     [2]Fighter
}

const fighterBytes = 4*4 + 2 + 1 + 1 + 1 + 1 + 1
const StateBytes = 4 + 1 + 2 + 2*fighterBytes

// New returns the opening state.
func New() State {
	var s State
	s.reset()
	return s
}

func (s *State) reset() {
	s.F[0] = Fighter{X: 250 * Q, HP: MaxHP, Facing: 1}
	s.F[1] = Fighter{X: 550 * Q, HP: MaxHP, Facing: -1}
}

func abs32(v int32) int32 {
	if v < 0 {
		return -v
	}
	return v
}

// Step advances one frame with both players' buttons.
func Step(s *State, in [2]uint8) {
	s.Frame++
	if s.KO > 0 {
		s.KO--
		if s.KO == 0 {
			s.reset()
		}
		return
	}
	for i := range 2 {
		f, o, b := &s.F[i], &s.F[1-i], in[i]
		pressed := b &^ f.Prev
		f.Prev = b
		switch {
		case f.Stun > 0:
			f.Stun--
			switch {
			case f.VX > 64:
				f.VX -= 64
			case f.VX < -64:
				f.VX += 64
			default:
				f.VX = 0
			}
		case f.Atk > 0:
			f.Atk++
			if f.Atk > AtkTotal {
				f.Atk, f.Hit = 0, 0
			}
			if f.Y == 0 {
				f.VX = 0
			}
		default:
			f.VX = 0
			if b&BtnLeft != 0 {
				f.VX -= Walk
			}
			if b&BtnRight != 0 {
				f.VX += Walk
			}
			if b&BtnJump != 0 && f.Y == 0 {
				f.VY = JumpV
			}
			if pressed&BtnAttack != 0 {
				f.Atk, f.Hit = 1, 0
			}
			if o.X > f.X {
				f.Facing = 1
			} else if o.X < f.X {
				f.Facing = -1
			}
		}
		f.X += f.VX
		if f.Y > 0 || f.VY > 0 {
			f.VY -= Grav
		}
		f.Y += f.VY
		if f.Y <= 0 {
			f.Y, f.VY = 0, 0
		}
		f.X = max(W/2, min(StageW-W/2, f.X))
	}
	// Bodies do not overlap: push apart equally.
	a, b := &s.F[0], &s.F[1]
	dx := b.X - a.X
	if abs32(dx) < W && abs32(a.Y-b.Y) < H {
		ov := W - abs32(dx)
		l, r := a, b
		if dx < 0 {
			l, r = b, a
		}
		l.X -= ov / 2
		r.X += ov - ov/2
		for _, f := range []*Fighter{a, b} {
			f.X = max(W/2, min(StageW-W/2, f.X))
		}
	}
	// Hits resolve together, from the moved positions.
	var hit [2]bool
	for i := range 2 {
		f, o := &s.F[i], &s.F[1-i]
		if f.Atk <= AtkStartup || f.Atk > AtkStartup+AtkActive || f.Hit != 0 {
			continue
		}
		front := f.X + int32(f.Facing)*W/2
		x0, x1 := front, front+int32(f.Facing)*AtkReach
		if x0 > x1 {
			x0, x1 = x1, x0
		}
		y0, y1 := f.Y+AtkLow, f.Y+AtkHigh
		if x1 > o.X-W/2 && x0 < o.X+W/2 && y1 > o.Y && y0 < o.Y+H {
			hit[i] = true
		}
	}
	for i := range 2 {
		if !hit[i] {
			continue
		}
		f, o := &s.F[i], &s.F[1-i]
		f.Hit = 1
		o.HP -= Damage
		o.Stun, o.Atk, o.Hit = StunFrames, 0, 0
		o.VX = int32(f.Facing) * Knock
	}
	if s.F[0].HP <= 0 || s.F[1].HP <= 0 {
		for i := range 2 {
			if s.F[1-i].HP <= 0 && s.F[i].HP > 0 {
				s.Score[i]++
			}
			s.F[i].HP = max(0, s.F[i].HP)
		}
		s.KO = KOPause
	}
}

// Encode writes the state little-endian into b (len ≥ StateBytes).
func (s *State) Encode(b []byte) {
	put32 := func(o int, v int32) {
		b[o], b[o+1], b[o+2], b[o+3] = byte(v), byte(v>>8), byte(v>>16), byte(v>>24)
	}
	put32(0, s.Frame)
	b[4], b[5], b[6] = s.KO, s.Score[0], s.Score[1]
	for i := range 2 {
		f, o := &s.F[i], 7+i*fighterBytes
		put32(o, f.X)
		put32(o+4, f.Y)
		put32(o+8, f.VX)
		put32(o+12, f.VY)
		b[o+16], b[o+17] = byte(f.HP), byte(f.HP>>8)
		b[o+18], b[o+19], b[o+20], b[o+21], b[o+22] = byte(f.Facing), f.Atk, f.Hit, f.Stun, f.Prev
	}
}

// Hash is FNV-1a 64 over Encode: the per-frame checksum peers compare.
func (s *State) Hash() uint64 {
	var b [StateBytes]byte
	s.Encode(b[:])
	h := uint64(14695981039346656037)
	for _, c := range b {
		h ^= uint64(c)
		h *= 1099511628211
	}
	return h
}
