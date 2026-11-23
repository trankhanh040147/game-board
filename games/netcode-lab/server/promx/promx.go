// Package promx holds the Prometheus metrics of M7 (A.12 "Measuring in
// production", P20): client-measured RTT, jitter and loss split by
// region × ISP × platform, plus the infrastructure state that explains them.
// Conditioner-driven values are simulated routes (A.16); the RTTs themselves
// are measured by clients over those routes.
package promx

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var labels = []string{"region", "isp", "platform"}

var (
	Registry = prometheus.NewRegistry()

	RTT = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name: "netlab_client_rtt_ms", Help: "Client-measured round trip (beacon pings and in-game reports), ms, over simulated routes.",
		Buckets: []float64{5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 140, 160, 200, 250, 300, 400, 600},
	}, labels)
	Jitter = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name: "netlab_client_jitter_ms", Help: "Client-measured jitter (mean |ΔRTT| per report), ms.",
		Buckets: []float64{0.5, 1, 2, 4, 8, 12, 16, 24, 32, 48, 64, 100},
	}, labels)
	Probes = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "netlab_client_probes_total", Help: "Beacon pings sent by clients.",
	}, labels)
	Lost = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "netlab_client_probes_lost_total", Help: "Beacon pings with no echo (timed out).",
	}, labels)
	CableCut = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "netlab_cable_cut", Help: "1 while the simulated cable cut on routes to sg is active.",
	})
	Tickets = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "netlab_matchmaker_tickets_total", Help: "Matchmaking tickets by outcome.",
	}, []string{"result", "region"})
	Wait = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name: "netlab_matchmaker_wait_seconds", Help: "Time from ticket to match.",
		Buckets: []float64{0.5, 1, 2, 5, 10, 15, 20, 30, 60},
	})
	RoomPlayers = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "netlab_region_players", Help: "Connected players per region room.",
	}, []string{"region"})
)

func init() {
	Registry.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		RTT, Jitter, Probes, Lost, CableCut, Tickets, Wait, RoomPlayers)
}

// Handler serves /metrics.
func Handler() http.Handler { return promhttp.HandlerFor(Registry, promhttp.HandlerOpts{}) }

// Platform keeps the label set small and known.
func Platform(p string) string {
	switch p {
	case "browser", "bot":
		return p
	}
	return "other"
}
