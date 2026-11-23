// Command server is the Netcode Lab game server. It serves the built client,
// the WebSocket endpoint and (with -https) HTTPS + WebTransport on one port.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"log/slog"
	"net/http"
	"net/http/pprof"
	"os"
	"os/signal"
	"syscall"

	"netcodelab/net/transport"
	"netcodelab/server"
	"netcodelab/server/matchmaker"
	"netcodelab/server/promx"
	"netcodelab/server/regions"
)

func main() {
	httpAddr := flag.String("http", "0.0.0.0:8080", "plain HTTP listen address (page + WebSocket)")
	httpsAddr := flag.String("https", "0.0.0.0:8443", "HTTPS (TCP) + WebTransport (UDP) listen address; empty disables")
	dist := flag.String("dist", "client/dist", "built client directory")
	extraWWW := flag.String("www", "bin/duel-www", "extra built pages served after -dist (infra.html, duel.html); empty disables")
	infra := flag.Bool("infra", true, "mount the M7 infrastructure demo: region rooms /r/{hcm,hn,sg}, beacons, matchmaker, /metrics")
	pprofOn := flag.Bool("pprof", false, "serve net/http/pprof at /debug/pprof/ (P19 allocation profiling; off by default)")
	relaxAfter := flag.Float64("relax-after", 10, "matchmaker: seconds before the threshold relaxes")
	verbose := flag.Bool("v", false, "debug logging")
	flag.Parse()

	lvl := slog.LevelInfo
	if *verbose {
		lvl = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: lvl}))

	token := os.Getenv("NETLAB_ADMIN_TOKEN")
	if token == "" {
		b := make([]byte, 6)
		rand.Read(b)
		token = hex.EncodeToString(b)
		log.Warn("NETLAB_ADMIN_TOKEN not set; generated one for this run", "adminToken", token)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	room := server.NewRoom(log, token)
	cfg := server.Config{HTTPAddr: *httpAddr, HTTPSAddr: *httpsAddr, DistDir: *dist}
	if *extraWWW != "" {
		cfg.ExtraWWW = []string{*extraWWW}
	}
	if *infra {
		// The same mounts as cmd/infra, so LAN players reach P16-P18/P20 and
		// the duel from the main URL.
		cfg.Mount = func(mux *http.ServeMux, wt func(func(transport.Conn)) http.Handler, certHash func() (string, int)) {
			rg := regions.NewManager(log, token)
			rg.Mount(mux, wt)
			rg.Run(ctx)
			mc := matchmaker.DefaultConfig()
			mc.Steps[1].AfterS = *relaxAfter
			matchmaker.New(mc).Mount(mux)
			mux.Handle("/metrics", promx.Handler())
			info := func(path string) http.HandlerFunc {
				return func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					w.Header().Set("Access-Control-Allow-Origin", "*")
					w.Header().Set("Cache-Control", "no-store")
					out := map[string]any{"wt": nil}
					if b64, port := certHash(); b64 != "" {
						out["wt"] = map[string]any{"path": path, "port": port, "certHashBase64": b64}
					}
					json.NewEncoder(w).Encode(out)
				}
			}
			mux.HandleFunc("/api/duel/info", info("/duel/wt"))
			mux.HandleFunc("/api/infra/info", info(""))
		}
	}
	if *pprofOn {
		prev := cfg.Mount
		cfg.Mount = func(mux *http.ServeMux, wt func(func(transport.Conn)) http.Handler, certHash func() (string, int)) {
			if prev != nil {
				prev(mux, wt, certHash)
			}
			mux.HandleFunc("/debug/pprof/", pprof.Index)
			mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
		}
	}
	if err := server.Serve(ctx, log, room, cfg); err != nil {
		log.Error("server", "err", err)
		os.Exit(1)
	}
}
