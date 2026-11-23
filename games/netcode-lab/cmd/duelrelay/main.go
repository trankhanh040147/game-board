// Command duelrelay runs the duel mini-mode relay (A.13) on its own ports, so
// it never touches the shooter's tick loop:
//
//	HTTP  :8090  /duel/ws (WebSocket), /api/duel/info, and the built client (duel.html)
//	HTTPS :8453  /duel/wt (WebTransport datagrams), same page over HTTPS
package main

import (
	"context"
	"crypto/tls"
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
)

func main() {
	httpAddr := flag.String("http", "0.0.0.0:8090", "plain HTTP: page + WebSocket relay")
	httpsAddr := flag.String("https", "0.0.0.0:8453", "HTTPS + WebTransport relay; empty disables")
	dist := flag.String("dist", "bin/duel-www", "built duel page (make duel-www)")
	flag.Parse()
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	rel := duelrelay.New(log)
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
	mux := http.NewServeMux()
	mux.Handle("/duel/ws", transport.WSHandler(rel.HandleConn))
	mux.HandleFunc("/api/duel/info", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Cache-Control", "no-store")
		info := map[string]any{"ws": "/duel/ws", "wt": nil, "profiles": duelrelay.Profiles, "defaultProfile": duelrelay.DefaultProfile}
		if cert != nil {
			info["wt"] = map[string]any{"path": "/duel/wt", "port": httpsPort, "certHashBase64": cert.HashB64, "certHashHex": cert.HashHex}
		}
		json.NewEncoder(w).Encode(info)
	})
	fs := http.FileServer(http.Dir(*dist))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			http.Redirect(w, r, "/duel.html", http.StatusFound)
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
	log.Info("duel relay http (page + WebSocket)", "addr", *httpAddr)
	if cert != nil {
		tlsConf := &tls.Config{Certificates: []tls.Certificate{cert.TLS}}
		h3 := &http3.Server{Addr: *httpsAddr, TLSConfig: http3.ConfigureTLSConfig(tlsConf.Clone()),
			QUICConfig: &quic.Config{EnableDatagrams: true, EnableStreamResetPartialDelivery: true}}
		webtransport.ConfigureHTTP3Server(h3)
		wt := &webtransport.Server{H3: h3, CheckOrigin: func(*http.Request) bool { return true }}
		h3mux := http.NewServeMux()
		h3mux.Handle("/duel/wt", transport.WTHandler(wt, rel.HandleConn))
		h3mux.Handle("/", mux)
		h3.Handler = h3mux
		go func() { errc <- wt.ListenAndServe() }()
		ts := &http.Server{Addr: *httpsAddr, Handler: mux, TLSConfig: tlsConf, ReadHeaderTimeout: 10 * time.Second}
		go func() { errc <- ts.ListenAndServeTLS("", "") }()
		log.Info("duel relay https + WebTransport", "addr", *httpsAddr, "certSHA256", cert.HashB64)
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
