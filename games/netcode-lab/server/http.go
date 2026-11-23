package server

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"

	"netcodelab/net/transport"
	"netcodelab/server/duelrelay"
	"netcodelab/shared"
)

type Config struct {
	HTTPAddr  string // plain HTTP: page + WebSocket (any LAN browser)
	HTTPSAddr string // HTTPS (TCP) + WebTransport/HTTP3 (UDP) on the same port; "" disables
	DistDir   string // built client (client/dist)
	// ExtraWWW are more built page directories served when a path is not in
	// DistDir (bin/duel-www holds infra.html and duel.html).
	ExtraWWW []string
	// AdvertiseHTTPSPort, when > 0, is the port browsers reach HTTPS/WebTransport on
	// (compose remaps ports); /certhash, /api/info and Mount report it.
	AdvertiseHTTPSPort int
	// Mount adds more handlers to the HTTP mux (cmd/server mounts the M7
	// regions, matchmaker and metrics here; package server cannot import
	// them without an import cycle). wt wraps a handler for WebTransport.
	Mount func(mux *http.ServeMux, wt func(onConn func(transport.Conn)) http.Handler, certHash func() (b64 string, port int))
}

// Serve starts the listeners and the tick loop; it blocks until ctx is done.
func Serve(ctx context.Context, log *slog.Logger, room *Room, cfg Config) error {
	var cert *Cert
	var wtSrv *webtransport.Server
	if cfg.HTTPSAddr != "" {
		var err error
		if cert, err = MintCert(); err != nil {
			return fmt.Errorf("cert: %w", err)
		}
	}

	mux := http.NewServeMux()
	mux.Handle("/ws", transport.WSHandler(room.HandleConn))
	// Duel mini-mode relay (M8, owned by "duel"), so LAN players reach it from the main URL.
	duel := duelrelay.New(log)
	mux.Handle("/duel/ws", transport.WSHandler(duel.HandleConn))
	mux.HandleFunc("/shared/map.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(shared.MapJSON)
	})
	httpsPort := 0
	if cfg.HTTPSAddr != "" {
		_, ps, _ := net.SplitHostPort(cfg.HTTPSAddr)
		httpsPort, _ = strconv.Atoi(ps)
	}
	if cfg.AdvertiseHTTPSPort > 0 {
		httpsPort = cfg.AdvertiseHTTPSPort
	}
	certHash := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if cert == nil {
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(map[string]any{"error": "WebTransport disabled (no -https)"})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{
			"algorithm": "sha-256", "base64": cert.HashB64, "hex": cert.HashHex,
			"notAfter": cert.NotAfter.UTC().Format(time.RFC3339),
			"wtPath":   "/wt", "port": httpsPort,
		})
	}
	mux.HandleFunc("/certhash", certHash)
	mux.HandleFunc("/api/certhash", certHash)
	mux.HandleFunc("/api/info", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		info := map[string]any{
			"protocolVersion": ProtocolVersion, "ws": "/ws", "wt": nil,
			"secure": r.TLS != nil, "serverTimeMs": room.NowMs(),
		}
		if cert != nil {
			info["wt"] = map[string]any{"path": "/wt", "port": httpsPort, "certHashBase64": cert.HashB64}
		}
		json.NewEncoder(w).Encode(info)
	})
	if cfg.Mount != nil {
		wt := func(on func(transport.Conn)) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if wtSrv == nil {
					http.NotFound(w, r)
					return
				}
				transport.WTHandler(wtSrv, on).ServeHTTP(w, r)
			})
		}
		cfg.Mount(mux, wt, func() (string, int) {
			if cert == nil {
				return "", 0
			}
			return cert.HashB64, httpsPort
		})
	}
	mux.Handle("/", staticHandler(cfg.DistDir, cfg.ExtraWWW...))

	errc := make(chan error, 3)
	hs := &http.Server{Addr: cfg.HTTPAddr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { errc <- hs.ListenAndServe() }()
	log.Info("http (page + WebSocket)", "addr", cfg.HTTPAddr)

	var tlsSrv *http.Server
	var h3 *http3.Server
	if cert != nil {
		tlsConf := &tls.Config{Certificates: []tls.Certificate{cert.TLS}}
		h3 = &http3.Server{
			Addr:       cfg.HTTPSAddr,
			TLSConfig:  http3.ConfigureTLSConfig(tlsConf.Clone()),
			QUICConfig: &quic.Config{EnableDatagrams: true, EnableStreamResetPartialDelivery: true},
		}
		webtransport.ConfigureHTTP3Server(h3)
		wtSrv = &webtransport.Server{H3: h3, CheckOrigin: func(*http.Request) bool { return true }}
		h3mux := http.NewServeMux()
		h3mux.Handle("/wt", transport.WTHandler(wtSrv, room.HandleConn))
		h3mux.Handle("/duel/wt", transport.WTHandler(wtSrv, duel.HandleConn))
		h3mux.Handle("/", mux)
		h3.Handler = h3mux
		go func() { errc <- wtSrv.ListenAndServe() }()

		tlsSrv = &http.Server{Addr: cfg.HTTPSAddr, Handler: mux, TLSConfig: tlsConf, ReadHeaderTimeout: 10 * time.Second}
		go func() { errc <- tlsSrv.ListenAndServeTLS("", "") }()
		log.Info("https (page + WebSocket) and WebTransport (UDP)", "addr", cfg.HTTPSAddr,
			"certSHA256", cert.HashB64, "notAfter", cert.NotAfter.Format(time.RFC3339), "ips", fmt.Sprint(cert.IPs))
	}

	go room.Run(ctx)

	select {
	case <-ctx.Done():
	case err := <-errc:
		if err != nil && err != http.ErrServerClosed {
			return err
		}
	}
	sctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	hs.Shutdown(sctx)
	if tlsSrv != nil {
		tlsSrv.Shutdown(sctx)
		wtSrv.Close()
	}
	return nil
}

// staticHandler serves the built client, or a plain page that says how to build it.
func staticHandler(dir string, extra ...string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			// Path missing from the client build: try the extra page dirs.
			clean := filepath.Clean("/" + r.URL.Path)
			if _, err := os.Stat(filepath.Join(dir, clean)); err != nil {
				for _, d := range extra {
					if _, err := os.Stat(filepath.Join(d, clean)); err == nil {
						if filepath.Ext(clean) == ".wasm" {
							w.Header().Set("Content-Type", "application/wasm")
						}
						w.Header().Set("Cache-Control", "no-cache")
						http.FileServer(http.Dir(d)).ServeHTTP(w, r)
						return
					}
				}
			}
		}
		if _, err := os.Stat(filepath.Join(dir, "index.html")); err != nil {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusServiceUnavailable)
			fmt.Fprintf(w, "Netcode Lab server is running, but the client is not built (%s/index.html missing).\nRun: make client\n", dir)
			return
		}
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			w.Header().Set("Cache-Control", "no-cache")
		}
		if filepath.Ext(r.URL.Path) == ".wasm" {
			w.Header().Set("Content-Type", "application/wasm")
		}
		fs.ServeHTTP(w, r)
	})
}

// EnvInt reads an int env var with a default.
func EnvInt(name string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil {
		return v
	}
	return def
}
