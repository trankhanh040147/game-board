package regions

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"

	"netcodelab/net/cond"
	"netcodelab/net/transport"
	"netcodelab/server"
	"netcodelab/server/promx"
)

// Manager runs one game Room per region and the beacons, and applies the
// simulated route of each connection through the Room's own per-client
// conditioner (a "cond" control the routed connection injects after join), so
// the Room code needs no region hook.
type Manager struct {
	log   *slog.Logger
	token string
	State State
	Rooms map[string]*server.Room

	mu    sync.Mutex
	conns map[*routedConn]struct{}
	seed  uint64
}

func NewManager(log *slog.Logger, adminToken string) *Manager {
	m := &Manager{log: log, token: adminToken, Rooms: map[string]*server.Room{}, conns: map[*routedConn]struct{}{}}
	for _, rg := range Regions {
		m.Rooms[rg] = server.NewRoom(log.With("region", rg), adminToken)
	}
	return m
}

// Run starts every region's tick loop.
func (m *Manager) Run(ctx context.Context) {
	for _, r := range m.Rooms {
		go r.Run(ctx)
	}
}

// who is a connection's place in the simulated network, from the URL query.
type who struct{ region, isp, lm, route, platform string }

func parseWho(region string, q *http.Request) who {
	v := q.URL.Query()
	return who{region: valid(region, Regions, "hcm"), isp: valid(v.Get("isp"), ISPs, "viettel"),
		lm: valid(v.Get("lm"), LastMiles, "good"), route: valid(v.Get("route"), Routes, "direct"),
		platform: promx.Platform(v.Get("platform"))}
}

func (m *Manager) route(w who) Route { return m.State.RouteFor(w.region, w.isp, w.lm, w.route) }

func (m *Manager) track(c *routedConn, on bool) {
	m.mu.Lock()
	if on {
		m.conns[c] = struct{}{}
	} else {
		delete(m.conns, c)
	}
	n := 0
	for o := range m.conns {
		if o.w.region == c.w.region && o.game {
			n++
		}
	}
	m.mu.Unlock()
	if c.game {
		promx.RoomPlayers.WithLabelValues(c.w.region).Set(float64(n))
	}
}

// SetCut switches the simulated cable cut and re-applies every live route to sg.
func (m *Manager) SetCut(on bool) {
	m.State.SetCut(on)
	if on {
		promx.CableCut.Set(1)
	} else {
		promx.CableCut.Set(0)
	}
	m.mu.Lock()
	var cs []*routedConn
	for c := range m.conns {
		cs = append(cs, c)
	}
	m.mu.Unlock()
	for _, c := range cs {
		c.reapply()
	}
	m.log.Info("cable cut (simulated)", "on", on)
}

// routedConn wraps a game connection: it passes everything through, injects
// the route as a self "cond" control after the join, and copies the client's
// periodic "report" (RTT, jitter) into the Prometheus histograms.
type routedConn struct {
	transport.Conn
	m      *Manager
	w      who
	game   bool
	in     chan transport.Msg
	inject chan transport.Msg
	err    error
	joined atomic.Bool
}

func (m *Manager) wrap(conn transport.Conn, w who) *routedConn {
	c := &routedConn{Conn: conn, m: m, w: w, game: true, in: make(chan transport.Msg, 256), inject: make(chan transport.Msg, 8)}
	go func() {
		for {
			msg, err := conn.Recv(context.Background())
			if err != nil {
				c.err = err
				close(c.in)
				return
			}
			c.in <- msg
		}
	}()
	return c
}

func (c *routedConn) condMsg() transport.Msg {
	p := c.m.route(c.w).OneWay()
	b, _ := json.Marshal(map[string]any{"t": "cond", "up": p, "down": p})
	return transport.Msg{Control: true, Data: b}
}

func (c *routedConn) reapply() {
	if !c.joined.Load() {
		return
	}
	select {
	case c.inject <- c.condMsg():
	default:
	}
}

func (c *routedConn) Recv(ctx context.Context) (transport.Msg, error) {
	select {
	case msg := <-c.inject:
		return msg, nil
	default:
	}
	select {
	case msg := <-c.inject:
		return msg, nil
	case msg, ok := <-c.in:
		if !ok {
			return transport.Msg{}, c.err
		}
		if msg.Control {
			c.observe(msg.Data)
		}
		return msg, nil
	case <-ctx.Done():
		return transport.Msg{}, ctx.Err()
	}
}

func (c *routedConn) observe(b []byte) {
	var v struct {
		T        string  `json:"t"`
		RTTMs    float64 `json:"rttMs"`
		JitterMs float64 `json:"jitterMs"`
	}
	if json.Unmarshal(b, &v) != nil {
		return
	}
	switch v.T {
	case "join":
		if c.joined.CompareAndSwap(false, true) {
			c.inject <- c.condMsg()
		}
	case "report":
		if v.RTTMs > 0 {
			promx.RTT.WithLabelValues(c.w.region, c.w.isp, c.w.platform).Observe(v.RTTMs)
			promx.Jitter.WithLabelValues(c.w.region, c.w.isp, c.w.platform).Observe(v.JitterMs)
		}
	}
}

func (m *Manager) gameHandler(region string) func(*http.Request) func(transport.Conn) {
	return func(q *http.Request) func(transport.Conn) {
		w := parseWho(region, q)
		return func(conn transport.Conn) {
			c := m.wrap(conn, w)
			m.track(c, true)
			defer m.track(c, false)
			m.log.Info("region join", "region", w.region, "isp", w.isp, "lastMile", w.lm, "route", w.route, "transport", conn.Kind())
			m.Rooms[region].HandleConn(c)
		}
	}
}

// beacon echoes every datagram back through the route's conditioner, both ways
// (P17: UDP-style ping, not ICMP). Over WebTransport these are real QUIC
// datagrams; over WebSocket the loss becomes a TCP stall (simulated).
func (m *Manager) beacon(region string) func(*http.Request) func(transport.Conn) {
	return func(q *http.Request) func(transport.Conn) {
		w := parseWho(region, q)
		return func(conn transport.Conn) {
			c := &routedConn{m: m, w: w, inject: make(chan transport.Msg, 1)}
			c.joined.Store(true)
			m.track(c, true)
			defer m.track(c, false)
			ordered := conn.Kind() == transport.KindWS
			m.mu.Lock()
			m.seed += 2
			seed := m.seed
			m.mu.Unlock()
			p := m.route(w).OneWay()
			down := cond.NewLink(p, ordered, seed, func(b []byte) { conn.SendDatagram(b) })
			up := cond.NewLink(p, ordered, seed+1, func(b []byte) { down.Push(b) })
			defer up.Close()
			defer down.Close()
			// Pings sent before this point would wait in the session's queue and read as RTT; clients wait for it.
			conn.SendControl([]byte(`{"t":"ready"}`))
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			go func() {
				for {
					select {
					case <-c.inject: // route changed (cable cut)
						p := m.route(w).OneWay()
						up.SetParams(p)
						down.SetParams(p)
					case <-ctx.Done():
						return
					}
				}
			}()
			for {
				msg, err := conn.Recv(ctx)
				if err != nil {
					return
				}
				if !msg.Control {
					up.Push(msg.Data)
				}
			}
		}
	}
}

// Mount registers the regions on a host mux (the game server, or cmd/infra):
//
//	/r/{hcm,hn,sg}/ws|wt        the region's game Room (query: isp, lm, route, platform)
//	/beacon/{region}/ws|wt      the region's ping beacon (same query)
//	GET  /api/regions           route table (simulated), paths, cable-cut state
//	POST /api/regions/cut       {"on":bool,"token":admin}
//	POST /api/infra/report      beacon results from a client → Prometheus
//
// wt wraps the host's WebTransport server; nil disables the /wt paths.
func (m *Manager) Mount(mux *http.ServeMux, wt func(onConn func(transport.Conn)) http.Handler) {
	for _, rg := range Regions {
		for path, mk := range map[string]func(*http.Request) func(transport.Conn){"/r/" + rg: m.gameHandler(rg), "/beacon/" + rg: m.beacon(rg)} {
			mux.Handle(path+"/ws", http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
				transport.WSHandler(mk(q)).ServeHTTP(w, q)
			}))
			if wt != nil {
				mux.Handle(path+"/wt", http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
					wt(mk(q)).ServeHTTP(w, q)
				}))
			}
		}
	}
	mux.HandleFunc("GET /api/regions", func(w http.ResponseWriter, q *http.Request) {
		t := m.State.Table()
		t["paths"] = map[string]any{"game": "/r/{region}/ws|wt", "beacon": "/beacon/{region}/ws|wt", "query": "isp, lm (last mile), route, platform"}
		writeJSON(w, t)
	})
	mux.HandleFunc("POST /api/regions/cut", func(w http.ResponseWriter, q *http.Request) {
		var in struct {
			On    bool   `json:"on"`
			Token string `json:"token"`
		}
		if json.NewDecoder(q.Body).Decode(&in) != nil || subtle.ConstantTimeCompare([]byte(in.Token), []byte(m.token)) != 1 {
			w.WriteHeader(http.StatusForbidden)
			writeJSON(w, map[string]any{"error": "admin token required"})
			return
		}
		m.SetCut(in.On)
		writeJSON(w, map[string]any{"cableCut": m.State.Cut()})
	})
	mux.HandleFunc("POST /api/infra/report", func(w http.ResponseWriter, q *http.Request) {
		var in struct {
			Region   string    `json:"region"`
			ISP      string    `json:"isp"`
			Platform string    `json:"platform"`
			RTTs     []float64 `json:"rtts"`
			Sent     int       `json:"sent"`
			Lost     int       `json:"lost"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, q.Body, 1<<16)).Decode(&in) != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		rg, isp, pl := valid(in.Region, Regions, ""), valid(in.ISP, ISPs, ""), promx.Platform(in.Platform)
		if rg == "" || isp == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		h := promx.RTT.WithLabelValues(rg, isp, pl)
		for i, v := range in.RTTs {
			h.Observe(v)
			if i > 0 {
				d := v - in.RTTs[i-1]
				if d < 0 {
					d = -d
				}
				promx.Jitter.WithLabelValues(rg, isp, pl).Observe(d)
			}
		}
		promx.Probes.WithLabelValues(rg, isp, pl).Add(float64(max(in.Sent, 0)))
		promx.Lost.WithLabelValues(rg, isp, pl).Add(float64(max(in.Lost, 0)))
		w.WriteHeader(http.StatusNoContent)
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}
