// Command server is the Netcode Lab game server. It serves the built client,
// the WebSocket endpoint and (with -https) HTTPS + WebTransport on one port.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/pprof"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
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
	advPort := flag.Int("advertise-https-port", 0, "HTTPS/WebTransport port to tell browsers when it differs from the listen port (docker port mapping); 0 = the listen port")
	botBin := flag.String("bot", "bin/bot", "bot binary for the Lab's P14 peek test (make bot); empty disables")
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
	if *botBin != "" {
		room.SetPeekRunner(peekRunner(*botBin, *httpAddr))
		room.SetFillBots(*botBin, "ws://"+selfAddr(*httpAddr)+"/ws") // {t:"fill"} (bots' fill bots)
		defer room.StopFill()
	}
	cfg := server.Config{HTTPAddr: *httpAddr, HTTPSAddr: *httpsAddr, DistDir: *dist, AdvertiseHTTPSPort: *advPort}
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

// peekRunner runs bots' P14 peek test (cmd/bot -kind peek) against this
// server's own WebSocket and returns its "peek" report.
func peekRunner(bin, httpAddr string) server.PeekRunner {
	return func(ctx context.Context, crossings, bufferMs int) (json.RawMessage, error) {
		if _, err := os.Stat(bin); err != nil {
			return nil, fmt.Errorf("bot binary %s not found (make bot)", bin)
		}
		base := selfAddr(httpAddr)
		cmd := exec.CommandContext(ctx, bin, "-kind", "peek", "-url", "ws://"+base+"/ws", "-info", "http://"+base,
			"-crossings", strconv.Itoa(crossings), "-peekbuf", strconv.Itoa(bufferMs),
			// The bot runs for its whole -d even when the crossings are done:
			// size it to the run (a 3-crossing run finished well inside 120 s).
			"-d", fmt.Sprintf("%ds", min(120, 20+8*crossings)), "-perbot=false")
		out, err := cmd.Output()
		if err != nil {
			return nil, fmt.Errorf("peek bots: %w", err)
		}
		var res struct {
			Peek json.RawMessage `json:"peek"`
		}
		if err := json.Unmarshal(out, &res); err != nil || len(res.Peek) == 0 {
			return nil, fmt.Errorf("peek bots: unexpected output (%d bytes)", len(out))
		}
		return res.Peek, nil
	}
}

// selfAddr turns the listen address into one this process can dial.
func selfAddr(httpAddr string) string {
	host, port, err := net.SplitHostPort(httpAddr)
	if err != nil {
		return httpAddr
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return net.JoinHostPort(host, port)
}
