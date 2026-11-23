package duel

import "math/rand/v2"

// BotInput is a seeded input source that plays like a simple human: it holds
// a direction for a while, jumps and attacks now and then.
type BotInput struct {
	r   *rand.Rand
	cur uint8
}

func NewBotInput(seed uint64) *BotInput {
	return &BotInput{r: rand.New(rand.NewPCG(seed, seed^0x5bd1e995))}
}

func (b *BotInput) Next() uint8 {
	if b.r.IntN(20) == 0 {
		b.cur = [...]uint8{0, BtnLeft, BtnRight, BtnRight, BtnLeft}[b.r.IntN(5)]
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

// Trace replays a recorded two-player input stream. It returns the hash after
// every frame of a plain run, and the confirmed hashes of two sessions that
// play the same inputs over a seeded simulated link (one-way delay uniform in
// [minMs, maxMs]) in the given mode and delay. All three must be equal, and
// equal across native and WASM builds. Frames 0..delay-1 have no input in a
// session, so the stream must be neutral there (the recorder writes 2 neutral frames).
func Trace(inputs [][2]uint8, mode Mode, delay int, minMs, maxMs float64, seed uint64) (plain []uint64, peers [2][]uint64) {
	s := New()
	plain = make([]uint64, len(inputs))
	for f, in := range inputs {
		Step(&s, in)
		plain[f] = s.Hash()
	}
	ss := [2]*Session{NewSession(Config{Side: 0, Delay: delay, Mode: mode}), NewSession(Config{Side: 1, Delay: delay, Mode: mode})}
	r := rand.New(rand.NewPCG(seed, 99))
	type pkt struct {
		at float64
		b  []byte
	}
	var q [2][]pkt
	now := 0.0
	n := int32(len(inputs))
	for i := range 2 {
		ss[i].Begin()
	}
	for slot := 0; (len(peers[0]) < len(inputs) || len(peers[1]) < len(inputs)) && slot < len(inputs)*20; slot++ {
		now += FrameMs
		for i := range 2 {
			keep := q[i][:0]
			for _, p := range q[i] {
				if p.at <= now {
					ss[i].Receive(p.b, now)
				} else {
					keep = append(keep, p)
				}
			}
			q[i] = keep
		}
		for i := range 2 {
			x := ss[i]
			// Local input for frame localN is the recorded input of that frame.
			var b uint8
			if x.localN < n {
				b = inputs[x.localN][i]
			}
			x.Tick(b, now)
			q[1-i] = append(q[1-i], pkt{now + minMs + r.Float64()*(maxMs-minMs), x.Packet(now)})
			for c := x.confirmed(); int32(len(peers[i])) < min(c, n); {
				f := int32(len(peers[i]))
				peers[i] = append(peers[i], x.hash[f%RingN])
			}
		}
	}
	return plain, peers
}

// AppendInputs writes a recorded stream: "NDIN", u32 frames, then 2 bytes per frame.
func AppendInputs(b []byte, n int, at func(f int) [2]uint8) []byte {
	b = append(b, 'N', 'D', 'I', 'N', byte(n), byte(n>>8), byte(n>>16), byte(n>>24))
	for f := range n {
		in := at(f)
		b = append(b, in[0], in[1])
	}
	return b
}

// ParseInputs reads a stream written by AppendInputs.
func ParseInputs(b []byte) ([][2]uint8, error) {
	if len(b) < 8 || string(b[:4]) != "NDIN" {
		return nil, ErrPacket
	}
	n := int(b[4]) | int(b[5])<<8 | int(b[6])<<16 | int(b[7])<<24
	if len(b) != 8+2*n {
		return nil, ErrPacket
	}
	out := make([][2]uint8, n)
	for f := range out {
		out[f] = [2]uint8{b[8+2*f], b[9+2*f]}
	}
	return out, nil
}

// TraceRuns are the session runs the determinism check replays.
var TraceRuns = []struct {
	Name         string
	Mode         Mode
	Delay        int
	MinMs, MaxMs float64
}{
	{"rb-d0", ModeRollback, 0, 20, 60},
	{"rb-d2", ModeRollback, 2, 40, 120},
	{"ls-d2", ModeLockstep, 2, 20, 60},
}

// TraceLines is the full determinism trace: "plain <f> <hash>" and
// "<run>/<peer> <f> <hash>" lines, then one "check" line saying whether every
// session hash equals the plain hash of the same frame.
func TraceLines(inputs [][2]uint8) []string {
	plain, _ := Trace(inputs, ModeRollback, 0, 0, 0, 1)
	var out []string
	for f, h := range plain {
		out = append(out, sprintf("plain", f, h))
	}
	mism := 0
	for k, r := range TraceRuns {
		_, peers := Trace(inputs, r.Mode, r.Delay, r.MinMs, r.MaxMs, uint64(k+1))
		for p := range 2 {
			for f, h := range peers[p] {
				out = append(out, sprintf(r.Name+"/"+string(rune('0'+p)), f, h))
				if h != plain[f] {
					mism++
				}
			}
			if len(peers[p]) != len(plain) {
				mism++
			}
		}
	}
	out = append(out, "check session-vs-plain mismatches "+itoa(mism))
	return out
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	var b []byte
	neg := v < 0
	if neg {
		v = -v
	}
	for v > 0 {
		b = append([]byte{byte('0' + v%10)}, b...)
		v /= 10
	}
	if neg {
		b = append([]byte{'-'}, b...)
	}
	return string(b)
}

func sprintf(name string, f int, h uint64) string {
	const hex = "0123456789abcdef"
	var hb [16]byte
	for i := 15; i >= 0; i-- {
		hb[i] = hex[h&15]
		h >>= 4
	}
	return name + " " + itoa(f) + " " + string(hb[:])
}
