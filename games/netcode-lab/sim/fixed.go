// Package sim is the shared deterministic simulation: movement, collision and
// hitboxes. The server, the bots and the browser (through WASM) run this code.
//
// All state is fixed-point (Q16.16 in int32) so native and WASM builds produce
// bit-identical results; there is no float math in the step.
package sim

import "math"

// Fx is a Q16.16 fixed-point number: 65536 = 1.0 (metres, seconds, m/s).
type Fx = int32

const (
	FxShift     = 16
	One      Fx = 1 << FxShift
	invSqrt2 Fx = 46341 // round(65536/sqrt(2))
)

// Mul multiplies two Q16.16 numbers.
func Mul(a, b Fx) Fx { return Fx((int64(a) * int64(b)) >> FxShift) }

// FromFloat converts a float to Q16.16. Used only when loading data, never in Step.
func FromFloat(f float64) Fx { return Fx(math.Round(f * float64(One))) }

// ToFloat converts Q16.16 to float64 for rendering and logs.
func ToFloat(v Fx) float64 { return float64(v) / float64(One) }

// isqrt64 is the integer square root (floor) of a non-negative int64.
func isqrt64(n int64) int64 {
	if n <= 0 {
		return 0
	}
	x := int64(math.Sqrt(float64(n))) // initial guess, corrected exactly below
	for x*x > n {
		x--
	}
	for (x+1)*(x+1) <= n {
		x++
	}
	return x
}

// Length2 returns the Q16.16 length of the vector (x, z).
func Length2(x, z Fx) Fx {
	return Fx(isqrt64(int64(x)*int64(x) + int64(z)*int64(z)))
}

// Sin and Cos take an angle where the full uint16 range is one turn
// (int16 yaw/pitch on the wire) and return Q16.16.
func Sin(a int16) Fx {
	i := uint16(a) >> 4 // 4096 steps per turn
	q, r := i>>10, i&1023
	switch q {
	case 0:
		return sinQuarter[r]
	case 1:
		return sinQuarter[1024-r]
	case 2:
		return -sinQuarter[r]
	default:
		return -sinQuarter[1024-r]
	}
}

func Cos(a int16) Fx { return Sin(int16(uint16(a) + 16384)) }

// AngleFromRadians quantises radians to the wire angle (65536 = 2*pi).
func AngleFromRadians(r float64) int16 {
	v := math.Round(r / (2 * math.Pi) * 65536)
	return int16(int64(v))
}

// AngleToRadians converts a wire angle back to radians.
func AngleToRadians(a int16) float64 { return float64(a) / 65536 * 2 * math.Pi }

// DtForRate is the fixed timestep in Q16.16 seconds for a tick rate (64 Hz = 1024).
func DtForRate(hz int) Fx {
	if hz <= 0 {
		hz = 64
	}
	return One / Fx(hz)
}
