// Command dueltrace is B.9 check 1 for the duel: it replays a recorded
// two-player input stream through duel.Trace and prints one hash per frame for
// a plain run and for both peers of rollback and lockstep sessions over a
// seeded simulated link. wasm/duel/test/determinism.mjs prints the same lines
// from the WASM build.
//
//	dueltrace -record sim/duel/testdata/inputs.bin   # (re)generate the stream
//	dueltrace -in sim/duel/testdata/inputs.bin       # print "<run> <frame> <hash>"
package main

import (
	"bufio"
	"flag"
	"fmt"
	"log"
	"os"

	"netcodelab/sim/duel"
)

func main() {
	rec := flag.String("record", "", "write a new input stream to this path")
	n := flag.Int("n", 3600, "frames to record (3600 = 1 min at 60 Hz)")
	in := flag.String("in", "", "input stream to replay")
	flag.Parse()
	if *rec != "" {
		a, b := duel.NewBotInput(2026), duel.NewBotInput(1123)
		buf := duel.AppendInputs([]byte(nil), *n, func(f int) [2]uint8 {
			if f < 2 {
				return [2]uint8{}
			}
			return [2]uint8{a.Next(), b.Next()}
		})
		if err := os.WriteFile(*rec, buf, 0o644); err != nil {
			log.Fatal(err)
		}
		return
	}
	raw, err := os.ReadFile(*in)
	if err != nil {
		log.Fatal(err)
	}
	inputs, err := duel.ParseInputs(raw)
	if err != nil {
		log.Fatal(err)
	}
	w := bufio.NewWriter(os.Stdout)
	defer w.Flush()
	for _, l := range duel.TraceLines(inputs) {
		fmt.Fprintln(w, l)
	}
}
