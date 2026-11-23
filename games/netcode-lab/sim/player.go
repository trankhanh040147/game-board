package sim

import (
	"encoding/binary"
	"hash/fnv"
)

// Buttons in Input.Buttons.
const (
	BtnForward uint16 = 1 << iota
	BtnBack
	BtnLeft
	BtnRight
	BtnJump
	BtnFire
)

// Player body. Pos is the centre of the feet.
var (
	HalfWidth = FromFloat(0.4)
	Height    = FromFloat(1.8)
	EyeHeight = FromFloat(1.6)

	// Hitboxes relative to the feet: one body box and one head box (B.3).
	BodyHalf   = FromFloat(0.35)
	BodyTop    = FromFloat(1.45)
	HeadHalf   = FromFloat(0.17)
	HeadBottom = FromFloat(1.45)
	HeadTop    = FromFloat(1.8)
)

// Params are the movement constants. Server-only modifiers (P25) scale SpeedScale.
type Params struct {
	MaxSpeed, Accel, AirAccel, Friction, StopSpeed, Gravity, JumpSpeed Fx
	SpeedScale                                                         Fx
}

// DefaultParams: 7 m/s run, ~1.05 m jump (crates are 1 m).
func DefaultParams() Params {
	return Params{
		MaxSpeed:   FromFloat(7),
		Accel:      FromFloat(10),
		AirAccel:   FromFloat(1.5),
		Friction:   FromFloat(6),
		StopSpeed:  FromFloat(1.5),
		Gravity:    FromFloat(20),
		JumpSpeed:  FromFloat(6.5),
		SpeedScale: One,
	}
}

// Input is one tick of player intent.
type Input struct {
	Buttons    uint16
	Yaw, Pitch int16
}

// State is a player's simulated state. It is exactly what the server sends
// back as the authoritative own state, so reconciliation compares it bit for bit.
type State struct {
	Pos, Vel   [3]Fx
	OnGround   bool
	Yaw, Pitch int16
}

// Hash is FNV-1a 64 over the state's fields (little-endian).
func (s State) Hash() uint64 {
	h := fnv.New64a()
	var b [31]byte
	for i := 0; i < 3; i++ {
		binary.LittleEndian.PutUint32(b[i*4:], uint32(s.Pos[i]))
		binary.LittleEndian.PutUint32(b[12+i*4:], uint32(s.Vel[i]))
	}
	if s.OnGround {
		b[24] = 1
	}
	binary.LittleEndian.PutUint16(b[25:], uint16(s.Yaw))
	binary.LittleEndian.PutUint16(b[27:], uint16(s.Pitch))
	h.Write(b[:29])
	return h.Sum64()
}

// AABB of a player standing at pos.
func PlayerBox(pos [3]Fx) Box {
	return Box{
		Min: [3]Fx{pos[0] - HalfWidth, pos[1], pos[2] - HalfWidth},
		Max: [3]Fx{pos[0] + HalfWidth, pos[1] + Height, pos[2] + HalfWidth},
	}
}

// HitBoxes returns the head and body boxes of a player at pos.
func HitBoxes(pos [3]Fx) (head, body Box) {
	head = Box{
		Min: [3]Fx{pos[0] - HeadHalf, pos[1] + HeadBottom, pos[2] - HeadHalf},
		Max: [3]Fx{pos[0] + HeadHalf, pos[1] + HeadTop, pos[2] + HeadHalf},
	}
	body = Box{
		Min: [3]Fx{pos[0] - BodyHalf, pos[1], pos[2] - BodyHalf},
		Max: [3]Fx{pos[0] + BodyHalf, pos[1] + BodyTop, pos[2] + BodyHalf},
	}
	return
}

// Step advances one player by one fixed tick. dt comes from DtForRate and is
// never a frame delta (B.4 rule 1).
func Step(m *Map, s *State, in Input, dt Fx, p *Params) {
	s.Yaw, s.Pitch = in.Yaw, in.Pitch

	var fwd, side Fx
	if in.Buttons&BtnForward != 0 {
		fwd += One
	}
	if in.Buttons&BtnBack != 0 {
		fwd -= One
	}
	if in.Buttons&BtnRight != 0 {
		side += One
	}
	if in.Buttons&BtnLeft != 0 {
		side -= One
	}
	if fwd != 0 && side != 0 {
		fwd, side = Mul(fwd, invSqrt2), Mul(side, invSqrt2)
	}
	sn, cs := Sin(in.Yaw), Cos(in.Yaw)
	// forward = (-sin, -cos), right = (cos, -sin) in (x, z); yaw 0 faces -Z.
	wx := Mul(fwd, -sn) + Mul(side, cs)
	wz := Mul(fwd, -cs) + Mul(side, -sn)
	var wishSpeed Fx
	if fwd != 0 || side != 0 {
		wishSpeed = Mul(p.MaxSpeed, p.SpeedScale)
	}

	if s.OnGround {
		applyFriction(s, dt, p)
		accelerate(s, wx, wz, wishSpeed, p.Accel, dt)
		if in.Buttons&BtnJump != 0 {
			s.Vel[1] = p.JumpSpeed
			s.OnGround = false
		}
	} else {
		accelerate(s, wx, wz, wishSpeed, p.AirAccel, dt)
	}
	s.Vel[1] -= Mul(p.Gravity, dt)

	// Swept collision, one axis at a time: Y, then X, then Z.
	dy := Mul(s.Vel[1], dt)
	moved, blocked := sweep(m, s.Pos, 1, dy)
	s.Pos[1] += moved
	s.OnGround = false
	if blocked {
		if dy < 0 {
			s.OnGround = true
		}
		s.Vel[1] = 0
	}
	for _, axis := range [2]int{0, 2} {
		d := Mul(s.Vel[axis], dt)
		moved, blocked := sweep(m, s.Pos, axis, d)
		s.Pos[axis] += moved
		if blocked {
			s.Vel[axis] = 0
		}
	}
}

func applyFriction(s *State, dt Fx, p *Params) {
	speed := Length2(s.Vel[0], s.Vel[2])
	if speed == 0 {
		return
	}
	control := max(speed, p.StopSpeed)
	drop := Mul(Mul(control, p.Friction), dt)
	ns := max(speed-drop, 0)
	s.Vel[0] = Fx(int64(s.Vel[0]) * int64(ns) / int64(speed))
	s.Vel[2] = Fx(int64(s.Vel[2]) * int64(ns) / int64(speed))
}

func accelerate(s *State, wx, wz, wishSpeed, accel, dt Fx) {
	if wishSpeed == 0 {
		return
	}
	current := Mul(s.Vel[0], wx) + Mul(s.Vel[2], wz)
	add := wishSpeed - current
	if add <= 0 {
		return
	}
	as := min(Mul(Mul(accel, dt), wishSpeed), add)
	s.Vel[0] += Mul(as, wx)
	s.Vel[2] += Mul(as, wz)
}

// sweep moves the player box along one axis by d and stops at the first box hit.
func sweep(m *Map, pos [3]Fx, axis int, d Fx) (Fx, bool) {
	if d == 0 {
		return 0, false
	}
	pb := PlayerBox(pos)
	blocked := false
	for i := range m.Boxes {
		b := &m.Boxes[i]
		overlap := true
		for o := 0; o < 3; o++ {
			if o != axis && !(pb.Min[o] < b.Max[o] && pb.Max[o] > b.Min[o]) {
				overlap = false
				break
			}
		}
		if !overlap {
			continue
		}
		if d > 0 && pb.Max[axis] <= b.Min[axis] && pb.Max[axis]+d > b.Min[axis] {
			d, blocked = b.Min[axis]-pb.Max[axis], true
		} else if d < 0 && pb.Min[axis] >= b.Max[axis] && pb.Min[axis]+d < b.Max[axis] {
			d, blocked = b.Max[axis]-pb.Min[axis], true
		}
	}
	return d, blocked
}
