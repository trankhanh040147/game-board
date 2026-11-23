package main

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sync"
	"time"

	"netcodelab/net/transport"
)

// statsMsg is the part of the server's 1 Hz control "stats" message the load
// harness keeps (PROTOCOL.md, Control JSON).
type statsMsg struct {
	ServerTick uint32 `json:"serverTick"`
	TickRate   int    `json:"tickRate"`
	SendRate   int    `json:"sendRate"`
	Players    int    `json:"players"`
	Tick       struct {
		Samples         int     `json:"samples"`
		BudgetMs        float64 `json:"budgetMs"`
		P50Ms           float64 `json:"p50Ms"`
		P99Ms           float64 `json:"p99Ms"`
		MaxMs           float64 `json:"maxMs"`
		WithinBudgetPct float64 `json:"withinBudgetPct"`
	} `json:"tick"`
	// Optional: present only on servers that report tick start lateness.
	TickStartLate *struct {
		P50Ms           float64 `json:"p50Ms"`
		P99Ms           float64 `json:"p99Ms"`
		MaxMs           float64 `json:"maxMs"`
		MaxSinceStartMs float64 `json:"maxSinceStartMs"`
		CatchUpTicks    int     `json:"catchUpTicks"`
		ScheduleResets  int     `json:"scheduleResets"`
	} `json:"tickStartLate"`
	// Whole window since server start or the last statsReset (core, 6c49cde).
	Window json.RawMessage `json:"window"`
}

type statsRecorder struct {
	conn    transport.Conn // the recording bot's connection, for statsReset
	token   string
	resetAt time.Time
	mu      sync.Mutex
	from    time.Time
	all     int
	kept    []statsMsg
	badJSON int
}

func (r *statsRecorder) setFrom(t time.Time) {
	r.mu.Lock()
	r.from = t
	r.mu.Unlock()
}

// reset asks the server to restart its whole-window histograms (needs the admin
// token); stats received in the next 1.1 s still mix the old window and are dropped.
func (r *statsRecorder) reset() error {
	r.mu.Lock()
	c, tok := r.conn, r.token
	r.mu.Unlock()
	if c == nil || tok == "" {
		return fmt.Errorf("statsReset needs the recording bot connected and -token")
	}
	b, _ := json.Marshal(map[string]string{"t": "statsReset", "token": tok})
	if err := c.SendControl(b); err != nil {
		return err
	}
	r.mu.Lock()
	r.resetAt = time.Now()
	r.from = r.resetAt.Add(1100 * time.Millisecond)
	r.kept = r.kept[:0]
	r.mu.Unlock()
	return nil
}

func (r *statsRecorder) add(raw []byte, at time.Time) {
	var m statsMsg
	err := json.Unmarshal(raw, &m)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.all++
	if err != nil {
		r.badJSON++
		return
	}
	if r.from.IsZero() || at.Before(r.from) {
		return // still ramping up or warming up
	}
	r.kept = append(r.kept, m)
}

func pct(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	return sorted[min(len(sorted)-1, int(float64(len(sorted))*p))]
}

// report aggregates the per-second server windows. The server reports p50/p99/max
// of the last tickRate ticks only, so exact whole-window percentiles cannot be
// rebuilt here: the report gives the distribution of the per-second values and
// the exact tick-weighted % within budget.
func (r *statsRecorder) report(bots int) map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := map[string]any{"statsMessagesReceived": r.all, "statsWindowsCounted": len(r.kept), "bots": bots}
	if len(r.kept) == 0 {
		out["error"] = "no server stats received after warmup"
		return out
	}
	var p50s, p99s, maxs, lateP99s []float64
	samples, within := 0, 0.0
	rates := map[int]int{}
	minPl, maxPl := 1<<30, 0
	lateMaxSinceStart := -1.0
	lateSecondsOver1 := 0
	for _, m := range r.kept {
		p50s = append(p50s, m.Tick.P50Ms)
		p99s = append(p99s, m.Tick.P99Ms)
		maxs = append(maxs, m.Tick.MaxMs)
		samples += m.Tick.Samples
		within += m.Tick.WithinBudgetPct / 100 * float64(m.Tick.Samples)
		rates[m.TickRate]++
		minPl, maxPl = min(minPl, m.Players), max(maxPl, m.Players)
		if m.TickStartLate != nil {
			lateP99s = append(lateP99s, m.TickStartLate.P99Ms)
			if m.TickStartLate.MaxMs > m.Tick.BudgetMs {
				lateSecondsOver1++
			}
			lateMaxSinceStart = m.TickStartLate.MaxSinceStartMs
		}
	}
	slices.Sort(p50s)
	slices.Sort(p99s)
	slices.Sort(maxs)
	first, last := r.kept[0], r.kept[len(r.kept)-1]
	if !r.resetAt.IsZero() {
		out["statsResetAt"] = r.resetAt.Format("15:04:05.000")
	}
	if len(last.Window) > 0 {
		out["wholeWindow"] = last.Window // server histograms since the reset (or start), verbatim
	}
	if last.TickStartLate != nil {
		out["catchUpTicks"] = last.TickStartLate.CatchUpTicks
		out["scheduleResets"] = last.TickStartLate.ScheduleResets
	}
	out["tickRates"] = rates
	out["sendRate"] = last.SendRate
	out["players"] = fmt.Sprintf("%d..%d", minPl, maxPl)
	out["budgetMs"] = last.Tick.BudgetMs
	out["serverTicks"] = fmt.Sprintf("%d..%d", first.ServerTick, last.ServerTick)
	out["ticksSampled"] = samples
	out["withinBudgetPct"] = round2(100 * within / float64(samples))
	out["perSecondP50Ms"] = map[string]float64{"median": round3(pct(p50s, 0.5)), "max": round3(p50s[len(p50s)-1])}
	out["perSecondP99Ms"] = map[string]float64{"median": round3(pct(p99s, 0.5)), "p95": round3(pct(p99s, 0.95)), "max": round3(p99s[len(p99s)-1])}
	out["perSecondMaxMs"] = map[string]float64{"median": round3(pct(maxs, 0.5)), "max": round3(maxs[len(maxs)-1])}
	out["p95Ms"] = nil
	out["note"] = "server stats carry p50/p99/max of the last tickRate ticks each second; p95 is not reported by the server, and whole-window percentiles are not recoverable from per-second ones"
	if len(lateP99s) > 0 {
		slices.Sort(lateP99s)
		out["tickStartLateP99Ms"] = map[string]float64{"median": round3(pct(lateP99s, 0.5)), "max": round3(lateP99s[len(lateP99s)-1])}
		out["tickStartLateMaxSinceServerStartMs"] = round3(lateMaxSinceStart)
		out["secondsWithATickStartLateOver1Period"] = lateSecondsOver1
	}
	return out
}

func round3(v float64) float64 { return float64(int64(v*1000+0.5)) / 1000 }

// setTickRate joins as a short-lived admin client, sends a Lab change and waits
// for the server to broadcast the new tick rate.
func setTickRate(ctx context.Context, url, token string, hz int) error {
	if token == "" {
		return fmt.Errorf("no admin token (-token or NETLAB_ADMIN_TOKEN)")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	conn, err := dial(ctx, url)
	if err != nil {
		return err
	}
	defer conn.Close("admin done")
	join, _ := json.Marshal(map[string]string{"t": "join", "name": "harness-admin"})
	if err := conn.SendControl(join); err != nil {
		return err
	}
	sent := false
	for {
		m, err := conn.Recv(ctx)
		if err != nil {
			return err
		}
		if !m.Control {
			continue
		}
		var c ctrl
		if json.Unmarshal(m.Data, &c) != nil {
			continue
		}
		switch c.T {
		case "welcome":
			if c.Settings != nil && c.Settings.TickRate == hz {
				return nil
			}
			lab, _ := json.Marshal(map[string]any{"t": "lab", "token": token, "settings": map[string]any{"tickRate": hz}})
			if err := conn.SendControl(lab); err != nil {
				return err
			}
			sent = true
		case "settings":
			if sent && c.Settings != nil && c.Settings.TickRate == hz {
				return nil
			}
		case "error":
			return fmt.Errorf("server: %s", c.Msg)
		}
	}
}

// applyLab joins as a short-lived admin client, sends one Lab change and waits
// for the server's settings broadcast (or its error).
func applyLab(ctx context.Context, url, token string, settings map[string]any) error {
	if token == "" {
		return fmt.Errorf("no admin token (-token or NETLAB_ADMIN_TOKEN)")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	conn, err := dial(ctx, url)
	if err != nil {
		return err
	}
	defer conn.Close("admin done")
	join, _ := json.Marshal(map[string]string{"t": "join", "name": "harness-admin"})
	if err := conn.SendControl(join); err != nil {
		return err
	}
	sent := false
	for {
		m, err := conn.Recv(ctx)
		if err != nil {
			return err
		}
		if !m.Control {
			continue
		}
		var c ctrl
		if json.Unmarshal(m.Data, &c) != nil {
			continue
		}
		switch {
		case c.T == "welcome" && !sent:
			lab, _ := json.Marshal(map[string]any{"t": "lab", "token": token, "settings": settings})
			if err := conn.SendControl(lab); err != nil {
				return err
			}
			sent = true
		case c.T == "settings" && sent:
			return nil
		case c.T == "error":
			return fmt.Errorf("server: %s", c.Msg)
		}
	}
}

func totals(out []Summary) map[string]any {
	var corr, repl, starvedMax uint64
	var inputs uint32
	snaps, errs := 0, 0
	var rtts []float64
	var rates []int
	for _, s := range out {
		corr += s.Corrections
		repl += s.Replayed
		inputs += s.InputsSent
		snaps += s.Snapshots
		if len(s.Errors) > 0 {
			errs++
		}
		starvedMax = max(starvedMax, uint64(s.ServerStarved))
		rtts = append(rtts, s.RTTMedianMs)
		rates = append(rates, s.TickRate)
	}
	slices.Sort(rtts)
	slices.Sort(rates)
	rates = slices.Compact(rates)
	return map[string]any{"corrections": corr, "replayed": repl, "inputsSent": inputs, "snapshots": snaps,
		"botsWithErrors": errs, "maxServerStarvedTicks": starvedMax, "rttMedianMsMedian": pct(rtts, 0.5), "tickRatesSeen": rates}
}
