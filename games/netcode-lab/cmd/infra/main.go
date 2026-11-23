// Command infra runs M7's infrastructure demo (A.12, P16–P18, P20) and the
// M8 duel relay in one process, next to the game server:
//
//	/r/{hcm,hn,sg}/ws|wt     three region instances of the game Room (simulated routes per ISP)
//	/beacon/{region}/ws|wt   ping beacons (WebTransport datagrams; WebSocket fallback)
//	/api/regions, /api/regions/cut, /api/infra/report, /api/mm/ticket[/{id}], /metrics
//	/duel/ws|wt, /api/duel/info, and the built pages infra.html and duel.html
//
// When the game server mounts these packages itself, this binary is not needed.
package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"flag"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"

	"netcodelab/net/transport"
	"netcodelab/server"
	"netcodelab/server/duelrelay"
	"netcodelab/server/matchmaker"
	"netcodelab/server/promx"
	"netcodelab/server/regions"
)

func main() {
	httpAddr := flag.String("http", "0.0.0.0:18720", "plain HTTP: pages, WebSocket, APIs, /metrics")
	httpsAddr := flag.String("https", "0.0.0.0:18721", "HTTPS + WebTransport; empty disables")
	www := flag.String("www", "bin/duel-www", "built pages (make duel-www): infra.html, duel.html")
	relaxAfter := flag.Float64("relax-after", 10, "matchmaker: seconds before the threshold relaxes")
	flag.Parse()
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	token := os.Getenv("NETLAB_ADMIN_TOKEN")
	if token == "" {
		b := make([]byte, 6)
		rand.Read(b)
		token = hex.EncodeToString(b)
		log.Warn("NETLAB_ADMIN_TOKEN not set; generated one for this run", "adminToken", token)
	}

	var cert *server.Cert
	if *httpsAddr != "" {
		var err error
		if cert, err = server.MintCert(); err != nil {
			log.Error("cert", "err", err)
			os.Exit(1)
		}
	}
	httpsPort := 0
	if *httpsAddr != "" {
		_, p, _ := net.SplitHostPort(*httpsAddr)
		httpsPort, _ = strconv.Atoi(p)
	}
	var wtSrv *webtransport.Server
	wt := func(on func(transport.Conn)) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if wtSrv == nil {
				http.NotFound(w, r)
				return
			}
			transport.WTHandler(wtSrv, on).ServeHTTP(w, r)
		})
	}

	mux := http.NewServeMux()
	rg := regions.NewManager(log, token)
	rg.Mount(mux, wt)
	rg.Run(ctx)
	cfg := matchmaker.DefaultConfig()
	cfg.Steps[1].AfterS = *relaxAfter
	matchmaker.New(cfg).Mount(mux)
	mux.Handle("/metrics", promx.Handler())

	duel := duelrelay.New(log)
	mux.Handle("/duel/ws", transport.WSHandler(duel.HandleConn))
	mux.Handle("/duel/wt", wt(duel.HandleConn))
	info := func(path string) func(http.ResponseWriter, *http.Request) {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Cache-Control", "no-store")
			out := map[string]any{"wt": nil}
			if cert != nil {
				out["wt"] = map[string]any{"path": path, "port": httpsPort, "certHashBase64": cert.HashB64, "certHashHex": cert.HashHex}
			}
			json.NewEncoder(w).Encode(out)
		}
	}
	mux.HandleFunc("/api/duel/info", info("/duel/wt"))
	mux.HandleFunc("/api/infra/info", info(""))
	fs := http.FileServer(http.Dir(*www))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			http.Redirect(w, r, "/infra.html", http.StatusFound)
			return
		}
		if filepath.Ext(r.URL.Path) == ".wasm" {
			w.Header().Set("Content-Type", "application/wasm")
		}
		w.Header().Set("Cache-Control", "no-cache")
		fs.ServeHTTP(w, r)
	})

	errc := make(chan error, 3)
	hs := &http.Server{Addr: *httpAddr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { errc <- hs.ListenAndServe() }()
	log.Info("infra http", "addr", *httpAddr)
	if cert != nil {
		tlsConf := &tls.Config{Certificates: []tls.Certificate{cert.TLS}}
		h3 := &http3.Server{Addr: *httpsAddr, TLSConfig: http3.ConfigureTLSConfig(tlsConf.Clone()),
			QUICConfig: &quic.Config{EnableDatagrams: true, EnableStreamResetPartialDelivery: true}}
		webtransport.ConfigureHTTP3Server(h3)
		wtSrv = &webtransport.Server{H3: h3, CheckOrigin: func(*http.Request) bool { return true }}
		h3.Handler = mux
		go func() { errc <- wtSrv.ListenAndServe() }()
		ts := &http.Server{Addr: *httpsAddr, Handler: mux, TLSConfig: tlsConf, ReadHeaderTimeout: 10 * time.Second}
		go func() { errc <- ts.ListenAndServeTLS("", "") }()
		log.Info("infra https + WebTransport", "addr", *httpsAddr, "certSHA256", cert.HashB64)
	}
	select {
	case <-ctx.Done():
	case err := <-errc:
		if err != nil && err != http.ErrServerClosed {
			log.Error("listen", "err", err)
			os.Exit(1)
		}
	}
}
