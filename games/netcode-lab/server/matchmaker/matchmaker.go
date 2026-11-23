// Package matchmaker is M7's matchmaker (A.12, P17). A ticket carries the
// player's RTT map (median of 10 beacon pings per region). The matchmaker
// picks the lowest-RTT region in its fleet whose RTT is under the current
// maximum-latency threshold, and relaxes that threshold the longer the ticket
// waits: 60 ms, then 100 ms after 10 s by default. The same JSON is served
// in-process by the game server and by cmd/matchmaker.
package matchmaker

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"slices"
	"sync"
	"time"

	"netcodelab/server/promx"
)

// Step: from AfterS seconds of waiting, accept regions up to MaxMs.
type Step struct {
	AfterS float64 `json:"afterS"`
	MaxMs  float64 `json:"maxMs"`
}

type Config struct {
	Fleet    []string `json:"fleet"` // regions that have servers; RTTs for anything else are ignored
	Steps    []Step   `json:"steps"`
	TimeoutS float64  `json:"timeoutS"`
}

func DefaultConfig() Config {
	return Config{Fleet: []string{"hcm", "hn", "sg"}, Steps: []Step{{0, 60}, {10, 100}}, TimeoutS: 60}
}

type Ticket struct {
	ID       string             `json:"id"`
	Player   string             `json:"player"`
	ISP      string             `json:"isp"`
	LastMile string             `json:"lm,omitempty"`
	Route    string             `json:"route,omitempty"`
	Platform string             `json:"platform,omitempty"`
	RTT      map[string]float64 `json:"rtt"` // region -> median beacon RTT, ms
}

// Event is one line of the ticket's history, shown in the UI.
type Event struct {
	AtS  float64 `json:"atS"`
	Text string  `json:"text"`
}

type Status struct {
	Ticket
	State     string   `json:"state"` // searching, matched, failed
	WaitedS   float64  `json:"waitedS"`
	MaxMs     float64  `json:"maxMs"` // current threshold
	NextStep  *Step    `json:"nextStep,omitempty"`
	Eligible  []string `json:"eligible"`
	Ignored   []string `json:"ignored,omitempty"` // regions in the RTT map with no fleet
	Region    string   `json:"region,omitempty"`
	RegionRTT float64  `json:"regionRttMs,omitempty"`
	GamePath  string   `json:"gamePath,omitempty"`
	Events    []Event  `json:"events"`
	Steps     []Step   `json:"steps"`
}

type entry struct {
	st      Status
	created time.Time
	stepIdx int
}

type MM struct {
	mu  sync.Mutex
	cfg Config
	t   map[string]*entry
	n   int
	now func() time.Time
}

func New(cfg Config) *MM { return &MM{cfg: cfg, t: map[string]*entry{}, now: time.Now} }

func (m *MM) threshold(waited float64) (int, Step) {
	i := 0
	for k, s := range m.cfg.Steps {
		if waited >= s.AfterS {
			i = k
		}
	}
	return i, m.cfg.Steps[i]
}

// Submit opens a ticket.
func (m *MM) Submit(t Ticket) Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.n++
	t.ID = fmt.Sprintf("t%d", m.n)
	e := &entry{created: m.now(), st: Status{Ticket: t, State: "searching", Steps: m.cfg.Steps}}
	for rg := range t.RTT {
		if !slices.Contains(m.cfg.Fleet, rg) {
			e.st.Ignored = append(e.st.Ignored, rg)
		}
	}
	slices.Sort(e.st.Ignored)
	e.st.Events = append(e.st.Events, Event{0, fmt.Sprintf("ticket opened, threshold %.0f ms", m.cfg.Steps[0].MaxMs)})
	if len(e.st.Ignored) > 0 {
		e.st.Events = append(e.st.Events, Event{0, fmt.Sprintf("ignored %v: no servers there (declaring latency for a location with no fleet)", e.st.Ignored)})
	}
	m.t[t.ID] = e
	m.eval(e)
	return e.st
}

// Get returns the ticket, re-evaluated at the current wait time.
func (m *MM) Get(id string) (Status, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.t[id]
	if !ok {
		return Status{}, false
	}
	m.eval(e)
	return e.st, true
}

func (m *MM) eval(e *entry) {
	if e.st.State != "searching" {
		return
	}
	waited := m.now().Sub(e.created).Seconds()
	e.st.WaitedS = math.Round(waited*10) / 10
	i, step := m.threshold(waited)
	for e.stepIdx < i {
		e.stepIdx++
		s := m.cfg.Steps[e.stepIdx]
		e.st.Events = append(e.st.Events, Event{s.AfterS, fmt.Sprintf("relaxed threshold to %.0f ms after %.0f s", s.MaxMs, s.AfterS)})
	}
	e.st.MaxMs = step.MaxMs
	e.st.NextStep = nil
	if i+1 < len(m.cfg.Steps) {
		n := m.cfg.Steps[i+1]
		e.st.NextStep = &n
	}
	e.st.Eligible = nil
	best, bestRTT := "", math.Inf(1)
	for _, rg := range m.cfg.Fleet {
		v, ok := e.st.RTT[rg]
		if !ok || v <= 0 {
			continue
		}
		if v <= step.MaxMs {
			e.st.Eligible = append(e.st.Eligible, rg)
			if v < bestRTT {
				best, bestRTT = rg, v
			}
		}
	}
	switch {
	case best != "":
		e.st.State, e.st.Region, e.st.RegionRTT, e.st.GamePath = "matched", best, bestRTT, "/r/"+best
		e.st.Events = append(e.st.Events, Event{e.st.WaitedS, fmt.Sprintf("matched to %s (%.0f ms ≤ %.0f ms)", best, bestRTT, step.MaxMs)})
		promx.Tickets.WithLabelValues("matched", best).Inc()
		promx.Wait.Observe(waited)
	case waited >= m.cfg.TimeoutS:
		e.st.State = "failed"
		e.st.Events = append(e.st.Events, Event{e.st.WaitedS, fmt.Sprintf("no region under %.0f ms after %.0f s", step.MaxMs, m.cfg.TimeoutS)})
		promx.Tickets.WithLabelValues("failed", "").Inc()
	}
}

// Mount registers POST /api/mm/ticket, GET /api/mm/ticket/{id} and GET /api/mm/config.
func (m *MM) Mount(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/mm/ticket", func(w http.ResponseWriter, q *http.Request) {
		var t Ticket
		if err := json.NewDecoder(http.MaxBytesReader(w, q.Body, 1<<14)).Decode(&t); err != nil || len(t.RTT) == 0 {
			w.WriteHeader(http.StatusBadRequest)
			writeJSON(w, map[string]any{"error": "ticket needs an rtt map"})
			return
		}
		writeJSON(w, m.Submit(t))
	})
	mux.HandleFunc("GET /api/mm/ticket/{id}", func(w http.ResponseWriter, q *http.Request) {
		st, ok := m.Get(q.PathValue("id"))
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			writeJSON(w, map[string]any{"error": "no such ticket"})
			return
		}
		writeJSON(w, st)
	})
	mux.HandleFunc("GET /api/mm/config", func(w http.ResponseWriter, q *http.Request) { writeJSON(w, m.cfg) })
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}
