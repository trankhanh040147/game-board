package sim

import "math"

// Hitscan geometry. Float64 is fine here: shot resolution runs only on the
// server and is not part of the deterministic movement state; the client uses
// the same functions (through WASM) only for cosmetics such as tracer length.

// Vec3 is a float position or direction in metres.
type Vec3 [3]float64

func (a Vec3) Add(b Vec3) Vec3       { return Vec3{a[0] + b[0], a[1] + b[1], a[2] + b[2]} }
func (a Vec3) Sub(b Vec3) Vec3       { return Vec3{a[0] - b[0], a[1] - b[1], a[2] - b[2]} }
func (a Vec3) Scale(s float64) Vec3  { return Vec3{a[0] * s, a[1] * s, a[2] * s} }
func (a Vec3) Len() float64          { return math.Sqrt(a[0]*a[0] + a[1]*a[1] + a[2]*a[2]) }
func VecFromFx(p [3]Fx) Vec3         { return Vec3{ToFloat(p[0]), ToFloat(p[1]), ToFloat(p[2])} }
func (b Box) Float() (min, max Vec3) { return VecFromFx(b.Min), VecFromFx(b.Max) }

// AimDir is the unit view direction for a wire yaw/pitch: yaw 0 faces -Z,
// positive yaw turns left, positive pitch looks up.
func AimDir(yaw, pitch int16) Vec3 {
	y, p := AngleToRadians(yaw), AngleToRadians(pitch)
	cp := math.Cos(p)
	return Vec3{-math.Sin(y) * cp, math.Sin(p), -math.Cos(y) * cp}
}

// EyePos is where shots start: the feet position plus the eye height.
func EyePos(pos [3]Fx) Vec3 {
	v := VecFromFx(pos)
	v[1] += ToFloat(EyeHeight)
	return v
}

// RayBox returns the entry distance of the ray into the box (slab method).
func RayBox(o, d Vec3, min, max Vec3) (float64, bool) {
	tmin, tmax := 0.0, math.Inf(1)
	for i := 0; i < 3; i++ {
		if math.Abs(d[i]) < 1e-12 {
			if o[i] < min[i] || o[i] > max[i] {
				return 0, false
			}
			continue
		}
		t1 := (min[i] - o[i]) / d[i]
		t2 := (max[i] - o[i]) / d[i]
		if t1 > t2 {
			t1, t2 = t2, t1
		}
		tmin = math.Max(tmin, t1)
		tmax = math.Min(tmax, t2)
		if tmin > tmax {
			return 0, false
		}
	}
	return tmin, true
}

// TraceMap returns the distance to the first map box along the ray, or maxDist.
func TraceMap(m *Map, o, d Vec3, maxDist float64) float64 {
	best := maxDist
	for i := range m.Boxes {
		mn, mx := m.Boxes[i].Float()
		if t, ok := RayBox(o, d, mn, mx); ok && t < best {
			best = t
		}
	}
	return best
}

// Hitbox ids.
const (
	HitNone uint8 = 0
	HitBody uint8 = 1
	HitHead uint8 = 2
)

// RayPlayer tests a ray against a player's head and body boxes at feet
// position pos (float metres) and returns the nearest hit.
func RayPlayer(o, d Vec3, pos Vec3) (float64, uint8) {
	hx := ToFloat(HeadHalf)
	bx := ToFloat(BodyHalf)
	head := [2]Vec3{{pos[0] - hx, pos[1] + ToFloat(HeadBottom), pos[2] - hx}, {pos[0] + hx, pos[1] + ToFloat(HeadTop), pos[2] + hx}}
	body := [2]Vec3{{pos[0] - bx, pos[1], pos[2] - bx}, {pos[0] + bx, pos[1] + ToFloat(BodyTop), pos[2] + bx}}
	best, part := math.Inf(1), HitNone
	if t, ok := RayBox(o, d, head[0], head[1]); ok {
		best, part = t, HitHead
	}
	if t, ok := RayBox(o, d, body[0], body[1]); ok && t < best {
		best, part = t, HitBody
	}
	return best, part
}
