package main

import (
	"context"
	"encoding/json"
	"os"
	"slices"
	"time"
)

// runProbe is a control for check 2: no game code, no network. It sleeps to an
// absolute tick schedule exactly like server.Room.Run (next += period) and
// counts how late each wake-up is. Late starts seen here come from the host,
// not from the server's code.
func runProbe(ctx context.Context, hz int) {
	period := time.Second / time.Duration(hz)
	next := time.Now()
	var lates []float64
	over1, over3 := 0, 0
	var worst []map[string]any
	t0 := time.Now()
	for ctx.Err() == nil {
		next = next.Add(period)
		if d := time.Until(next); d > 0 {
			time.Sleep(d)
		} else if -d > 5*period {
			next = time.Now() // same catch-up rule as the server
		}
		late := time.Since(next)
		ms := float64(late.Nanoseconds()) / 1e6
		lates = append(lates, ms)
		if late > period {
			over1++
		}
		if late > 3*period {
			over3++
			worst = append(worst, map[string]any{"at": time.Now().Format("15:04:05.000"), "lateMs": round2(ms)})
		}
	}
	slices.Sort(lates)
	n := len(lates)
	out := map[string]any{"kind": "probe", "hz": hz, "seconds": round2(time.Since(t0).Seconds()), "ticks": n,
		"lateOver1PeriodTicks": over1, "lateOver3PeriodTicks": over3,
		"lateMs":            map[string]float64{"p50": round3(pct(lates, 0.5)), "p99": round3(pct(lates, 0.99)), "p999": round3(pct(lates, 0.999)), "max": round3(lates[n-1])},
		"over3PeriodEvents": worst}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.Encode(out)
}
