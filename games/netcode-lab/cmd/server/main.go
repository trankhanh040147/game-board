// Command server is the Netcode Lab game server. It serves the built client,
// the WebSocket endpoint and (with -https) HTTPS + WebTransport on one port.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"netcodelab/server"
)

func main() {
	httpAddr := flag.String("http", "0.0.0.0:8080", "plain HTTP listen address (page + WebSocket)")
	httpsAddr := flag.String("https", "0.0.0.0:8443", "HTTPS (TCP) + WebTransport (UDP) listen address; empty disables")
	dist := flag.String("dist", "client/dist", "built client directory")
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
	if err := server.Serve(ctx, log, room, server.Config{HTTPAddr: *httpAddr, HTTPSAddr: *httpsAddr, DistDir: *dist}); err != nil {
		log.Error("server", "err", err)
		os.Exit(1)
	}
}
