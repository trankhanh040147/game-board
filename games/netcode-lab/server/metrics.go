package server

import (
	"math"
	"runtime/debug"
	"runtime/metrics"
	"sync"
)

// hist is a cumulative histogram of milliseconds with 10 µs buckets up to
// 50 ms plus an overflow bucket, so whole-window percentiles cost O(1) per
// sample and no allocation (B.9 check 5, P19).
type hist struct {
	mu     sync.Mutex
	counts [5001]uint64
	n      uint64
	sum    float64
	max    float64
	over   uint64 // samples above the budget given to add
}

func (h *hist) add(ms, budget float64) {
	i := int(ms * 100)
	if i < 0 {
		i = 0
	}
	if i >= len(h.counts) {
		i = len(h.counts) - 1
	}
	h.mu.Lock()
	h.counts[i]++
	h.n++
	h.sum += ms
	h.max = math.Max(h.max, ms)
	if ms > budget {
		h.over++
	}
	h.mu.Unlock()
}

func (h *hist) reset() {
	h.mu.Lock()
	*h = hist{}
	h.mu.Unlock()
}

// HistStats are whole-window figures. Percentiles are bucket upper bounds
// (10 µs resolution); "p99" is reported only with at least 100 samples.
type HistStats struct {
	Samples         uint64   `json:"samples"`
	MeanMs          float64  `json:"meanMs"`
	P50Ms           float64  `json:"p50Ms"`
	P95Ms           float64  `json:"p95Ms"`
	P99Ms           *float64 `json:"p99Ms"`
	P999Ms          *float64 `json:"p999Ms"`
	MaxMs           float64  `json:"maxMs"`
	OverBudget      uint64   `json:"overBudget"`
	WithinBudgetPct float64  `json:"withinBudgetPct"`
}

func (h *hist) stats() HistStats {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := HistStats{Samples: h.n, MaxMs: h.max, OverBudget: h.over}
	if h.n == 0 {
		return s
	}
	s.MeanMs = h.sum / float64(h.n)
	s.WithinBudgetPct = 100 * float64(h.n-h.over) / float64(h.n)
	q := func(p float64) float64 {
		target := uint64(math.Ceil(p * float64(h.n)))
		var acc uint64
		for i, c := range h.counts {
			acc += c
			if acc >= target {
				if i == len(h.counts)-1 {
					return h.max
				}
				return math.Min(float64(i+1)/100, h.max)
			}
		}
		return h.max
	}
	s.P50Ms, s.P95Ms = q(0.50), q(0.95)
	if h.n >= 100 {
		v := q(0.99)
		s.P99Ms = &v
	}
	if h.n >= 1000 {
		v := q(0.999)
		s.P999Ms = &v
	}
	return s
}

// GCStats from runtime/metrics (P19).
type GCStats struct {
	Cycles     uint64  `json:"cycles"`
	PauseP50Ms float64 `json:"pauseP50Ms"`
	PauseP99Ms float64 `json:"pauseP99Ms"`
	PauseMaxMs float64 `json:"pauseMaxMs"` // upper bound of the highest non-empty bucket
	PauseCount uint64  `json:"pauseCount"`
	HeapBytes  uint64  `json:"heapBytes"`
	AllocBytes uint64  `json:"allocBytesTotal"`
	GoMemLimit uint64  `json:"goMemLimitBytes"`
	Goroutines uint64  `json:"goroutines"`
}

var gcSamples = []metrics.Sample{
	{Name: "/gc/cycles/total:gc-cycles"},
	{Name: "/sched/pauses/total/gc:seconds"},
	{Name: "/memory/classes/heap/objects:bytes"},
	{Name: "/gc/heap/allocs:bytes"},
	{Name: "/gc/gomemlimit:bytes"},
	{Name: "/sched/goroutines:goroutines"},
}

func readGC() GCStats {
	s := make([]metrics.Sample, len(gcSamples))
	copy(s, gcSamples)
	metrics.Read(s)
	var g GCStats
	u := func(i int) uint64 {
		if s[i].Value.Kind() == metrics.KindUint64 {
			return s[i].Value.Uint64()
		}
		return 0
	}
	g.Cycles, g.HeapBytes, g.AllocBytes, g.GoMemLimit, g.Goroutines = u(0), u(2), u(3), u(4), u(5)
	if s[1].Value.Kind() == metrics.KindFloat64Histogram {
		h := s[1].Value.Float64Histogram()
		var n uint64
		for _, c := range h.Counts {
			n += c
		}
		g.PauseCount = n
		q := func(p float64) float64 {
			if n == 0 {
				return 0
			}
			target := uint64(math.Ceil(p * float64(n)))
			var acc uint64
			for i, c := range h.Counts {
				acc += c
				if acc >= target {
					return h.Buckets[i+1] * 1000
				}
			}
			return 0
		}
		g.PauseP50Ms, g.PauseP99Ms = q(0.5), q(0.99)
		for i := len(h.Counts) - 1; i >= 0; i-- {
			if h.Counts[i] > 0 {
				g.PauseMaxMs = h.Buckets[i+1] * 1000
				break
			}
		}
		if math.IsInf(g.PauseMaxMs, 1) {
			g.PauseMaxMs = -1 // above the last finite bucket
		}
	}
	return g
}

// startMemLimit is the limit at process start (the GOMEMLIMIT env var, or none).
var startMemLimit = debug.SetMemoryLimit(-1)

// applyMemLimit sets the soft memory limit from the Lab; 0 restores the
// process's starting limit.
func applyMemLimit(mb int) {
	if mb <= 0 {
		debug.SetMemoryLimit(startMemLimit)
		return
	}
	debug.SetMemoryLimit(int64(mb) << 20)
}
