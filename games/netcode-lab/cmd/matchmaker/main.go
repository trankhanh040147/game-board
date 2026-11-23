// Command matchmaker serves the M7 matchmaker on its own (B.8). It speaks the
// same ticket JSON as the in-process one in cmd/infra: POST /api/mm/ticket,
// GET /api/mm/ticket/{id}, GET /api/mm/config, plus /metrics.
package main

import (
	"flag"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"netcodelab/server/matchmaker"
	"netcodelab/server/promx"
)

func main() {
	addr := flag.String("http", "0.0.0.0:18740", "listen address")
	first := flag.Float64("max", 60, "initial max-latency threshold, ms")
	relaxed := flag.Float64("relaxed", 100, "relaxed threshold, ms")
	after := flag.Float64("relax-after", 10, "seconds of waiting before relaxing")
	fleet := flag.String("fleet", "hcm,hn,sg", "regions that have servers")
	flag.Parse()
	cfg := matchmaker.DefaultConfig()
	cfg.Fleet = strings.Split(*fleet, ",")
	cfg.Steps = []matchmaker.Step{{AfterS: 0, MaxMs: *first}, {AfterS: *after, MaxMs: *relaxed}}
	mux := http.NewServeMux()
	matchmaker.New(cfg).Mount(mux)
	mux.Handle("/metrics", promx.Handler())
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	log.Info("matchmaker", "addr", *addr, "steps", cfg.Steps, "fleet", cfg.Fleet)
	s := &http.Server{Addr: *addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	if err := s.ListenAndServe(); err != nil {
		log.Error("listen", "err", err)
		os.Exit(1)
	}
}
