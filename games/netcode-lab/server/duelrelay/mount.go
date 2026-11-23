package duelrelay

import (
	"net/http"
	"path/filepath"

	"netcodelab/net/transport"
)

// Mount puts the duel on another server's mux (the game server), so LAN
// teammates reach it from the main URL: /duel/ws (WebSocket), /duel/wt
// (WebTransport, through wt, which wraps the host's WebTransport server) and
// the built page under /duel/ (www = bin/duel-www). The page then lives at
// /duel/duel.html and reads WebTransport details from the host's /api/info.
func (r *Relay) Mount(mux *http.ServeMux, wt func(onConn func(transport.Conn)) http.Handler, www string) {
	mux.Handle("/duel/ws", transport.WSHandler(r.HandleConn))
	if wt != nil {
		mux.Handle("/duel/wt", wt(r.HandleConn))
	}
	fs := http.StripPrefix("/duel/", http.FileServer(http.Dir(www)))
	mux.HandleFunc("/duel/", func(w http.ResponseWriter, q *http.Request) {
		if q.URL.Path == "/duel/" {
			http.Redirect(w, q, "/duel/duel.html", http.StatusFound)
			return
		}
		if filepath.Ext(q.URL.Path) == ".wasm" {
			w.Header().Set("Content-Type", "application/wasm")
		}
		w.Header().Set("Cache-Control", "no-cache")
		fs.ServeHTTP(w, q)
	})
}
