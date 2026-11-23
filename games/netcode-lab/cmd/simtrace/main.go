// Command simtrace runs a recorded input stream through the native sim and
// prints one state hash per tick. wasm/test/determinism.mjs prints the same
// lines from the WASM build; B.9 check 1 compares the two.
//
//	simtrace -record sim/testdata/inputs.bin   # (re)generate the stream
//	simtrace -in sim/testdata/inputs.bin       # print "<hz> <tick> <hash>"
package main

import (
	"bufio"
	"encoding/binary"
	"flag"
	"fmt"
	"log"
	"math/rand/v2"
	"os"

	"netcodelab/sim"
)

// Rates replayed by the check: every tick rate the Lab allows.
var rates = []int{20, 30, 64, 128}

func record(path string, n int) {
	// A seeded walker: runs, strafes, turns continuously and in jumps, jumps,
	// stands still sometimes and walks into walls, so collision paths run.
	rng := rand.New(rand.NewPCG(2026, 11))
	b := []byte("NLIN")
	b = binary.LittleEndian.AppendUint32(b, uint32(n))
	yaw, pitch := int16(0), int16(0)
	btn := sim.BtnForward
	for i := 0; i < n; i++ {
		if rng.IntN(48) == 0 {
			btn = uint16(rng.IntN(16)) // any WASD combination, including none
		}
		if rng.IntN(90) == 0 {
			btn |= sim.BtnJump
		} else {
			btn &^= sim.BtnJump
		}
		if rng.IntN(120) == 0 {
			yaw += int16(rng.IntN(65536))
		}
		yaw += int16(rng.IntN(600) - 300)
		pitch = int16(max(-16000, min(16000, int(pitch)+rng.IntN(400)-200)))
		b = binary.LittleEndian.AppendUint16(b, btn)
		b = binary.LittleEndian.AppendUint16(b, uint16(yaw))
		b = binary.LittleEndian.AppendUint16(b, uint16(pitch))
	}
	if err := os.WriteFile(path, b, 0o644); err != nil {
		log.Fatal(err)
	}
}

func load(path string) []sim.Input {
	b, err := os.ReadFile(path)
	if err != nil {
		log.Fatal(err)
	}
	if len(b) < 8 || string(b[:4]) != "NLIN" {
		log.Fatal("bad input stream")
	}
	n := int(binary.LittleEndian.Uint32(b[4:]))
	in := make([]sim.Input, n)
	for i := range in {
		o := 8 + i*6
		in[i] = sim.Input{Buttons: binary.LittleEndian.Uint16(b[o:]), Yaw: int16(binary.LittleEndian.Uint16(b[o+2:])), Pitch: int16(binary.LittleEndian.Uint16(b[o+4:]))}
	}
	return in
}

func main() {
	rec := flag.String("record", "", "write a new input stream to this path")
	n := flag.Int("n", 7680, "ticks to record (7680 = 2 min at 64 Hz)")
	in := flag.String("in", "", "input stream to replay")
	flag.Parse()
	if *rec != "" {
		record(*rec, *n)
		return
	}
	inputs := load(*in)
	m := sim.Courtyard()
	w := bufio.NewWriter(os.Stdout)
	defer w.Flush()
	for _, hz := range rates {
		s := sim.State{Pos: m.Spawn("blue", 0), OnGround: true}
		p := sim.DefaultParams()
		dt := sim.DtForRate(hz)
		for i, inp := range inputs {
			sim.Step(m, &s, inp, dt, &p)
			fmt.Fprintf(w, "%d %d %016x\n", hz, i, s.Hash())
		}
	}
}
