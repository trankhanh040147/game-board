// Package duelrelay is the duel mini-mode's server side (A.13): a dumb relay.
// Two peers join a named room; each binary datagram from one peer goes
// straight to the other, through the in-process conditioner of the sender's
// uplink and the receiver's downlink, with no playout buffer and no sim. The
// peers run the deterministic sim themselves (rollback or lockstep).
//
// It does not touch the shooter's Room: it is mounted on its own paths
// (/duel/ws, /duel/wt) by cmd/duelrelay, or by the game server if core mounts it.
package duelrelay

import (
	"context"
	"encoding/json"
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"

	"netcodelab/net/cond"
	"netcodelab/net/transport"
)

// Profiles match the client's conditioner presets (B.7), per client and direction.
var Profiles = map[string]cond.Params{
	"lan":     {},
	"default": {DelayMs: 20},                           // "Default (40 ms)" RTT to the relay
	"bad":     {DelayMs: 40, JitterMs: 15, LossPct: 1}, // "Bad route (80 ms, jitter 15, loss 1%)"
}

// DefaultProfile is applied at join, like the shooter's default conditioner.
const DefaultProfile = "default"

type Relay struct {
	log   *slog.Logger
	mu    sync.Mutex
	rooms map[string]*room
	seed  uint64
}

type room struct {
	name  string
	peers [2]*peer
	epoch uint16
	mode  int
	delay int // -1 auto
}

type peer struct {
	conn     transport.Conn
	name     string
	bot      bool
	side     int
	room     *room
	up, down *cond.Link
	profile  string
}

func New(log *slog.Logger) *Relay {
	return &Relay{log: log, rooms: map[string]*room{}, seed: uint64(time.Now().UnixNano())}
}

type ctrl struct {
	T       string       `json:"t"`
	Room    string       `json:"room,omitempty"`
	Name    string       `json:"name,omitempty"`
	Bot     bool         `json:"bot,omitempty"`
	Mode    *int         `json:"mode,omitempty"`
	Delay   *int         `json:"delay,omitempty"`
	Profile string       `json:"profile,omitempty"`
	Up      *cond.Params `json:"up,omitempty"`
	Down    *cond.Params `json:"down,omitempty"`
}

func send(c transport.Conn, v any) {
	b, _ := json.Marshal(v)
	c.SendControl(b)
}

// HandleConn runs one peer connection until it closes.
func (r *Relay) HandleConn(conn transport.Conn) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	jctx, jcancel := context.WithTimeout(ctx, 15*time.Second)
	var join ctrl
	for {
		m, err := conn.Recv(jctx)
		if err != nil {
			jcancel()
			conn.Close("join timeout")
			return
		}
		if m.Control && json.Unmarshal(m.Data, &join) == nil && join.T == "join" {
			break
		}
	}
	jcancel()
	if join.Room == "" {
		join.Room = "duel"
	}
	p, err := r.add(conn, join)
	if err != nil {
		send(conn, map[string]any{"t": "error", "error": err.Error()})
		conn.Close(err.Error())
		return
	}
	defer r.remove(p)

	for {
		m, err := conn.Recv(ctx)
		if err != nil {
			return
		}
		if !m.Control {
			p.up.Push(m.Data)
			continue
		}
		var in ctrl
		if json.Unmarshal(m.Data, &in) != nil {
			continue
		}
		switch in.T {
		case "restart":
			r.mu.Lock()
			if in.Mode != nil {
				p.room.mode = *in.Mode
			}
			if in.Delay != nil {
				p.room.delay = *in.Delay
			}
			r.startLocked(p.room)
			r.mu.Unlock()
		case "cond":
			r.setCond(p, in)
		}
	}
}

type errStr string

func (e errStr) Error() string { return string(e) }

func (r *Relay) add(conn transport.Conn, j ctrl) (*peer, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rm := r.rooms[j.Room]
	if rm == nil {
		rm = &room{name: j.Room, delay: -1}
		r.rooms[j.Room] = rm
	}
	side := -1
	for i := range 2 {
		if rm.peers[i] == nil {
			side = i
			break
		}
	}
	if side < 0 {
		return nil, errStr("room " + j.Room + " is full (2 peers)")
	}
	p := &peer{conn: conn, name: j.Name, bot: j.Bot, side: side, room: rm, profile: DefaultProfile}
	ordered := conn.Kind() == transport.KindWS // TCP: loss becomes a retransmit stall (simulated)
	r.seed++
	pr := Profiles[DefaultProfile]
	p.down = cond.NewLink(pr, ordered, r.seed*2+1, func(b []byte) { conn.SendDatagram(b) })
	p.up = cond.NewLink(pr, ordered, r.seed*2, func(b []byte) {
		r.mu.Lock()
		o := rm.peers[1-p.side]
		r.mu.Unlock()
		if o != nil && o != p {
			o.down.Push(b)
		}
	})
	rm.peers[side] = p
	r.log.Info("duel join", "room", rm.name, "side", side, "name", j.Name, "bot", j.Bot, "transport", conn.Kind(), "remote", conn.RemoteAddr())
	send(conn, map[string]any{"t": "welcome", "room": rm.name, "side": side, "transport": conn.Kind(),
		"profile": p.profile, "up": pr, "down": pr, "profiles": Profiles})
	if rm.peers[0] != nil && rm.peers[1] != nil {
		r.startLocked(rm)
	} else {
		send(conn, map[string]any{"t": "wait"})
	}
	return p, nil
}

// startLocked begins a new match (epoch) for both peers at once. Control
// messages bypass the conditioner (as in the shooter), so both start together.
func (r *Relay) startLocked(rm *room) {
	if rm.peers[0] == nil || rm.peers[1] == nil {
		return
	}
	rm.epoch++
	seed := rand.Uint32()
	for i, p := range rm.peers {
		o := rm.peers[1-i]
		send(p.conn, map[string]any{"t": "start", "side": i, "epoch": rm.epoch, "seed": seed, "mode": rm.mode,
			"delay": rm.delay, "peer": o.name, "peerBot": o.bot, "peerTransport": o.conn.Kind(), "peerProfile": o.profile})
	}
	r.log.Info("duel start", "room", rm.name, "epoch", rm.epoch, "mode", rm.mode, "delay", rm.delay)
}

func (r *Relay) setCond(p *peer, in ctrl) {
	up, down := p.up.Params(), p.down.Params()
	name := "custom"
	if pr, ok := Profiles[in.Profile]; ok {
		up, down, name = pr, pr, in.Profile
	}
	if in.Up != nil {
		up, name = *in.Up, "custom"
	}
	if in.Down != nil {
		down, name = *in.Down, "custom"
	}
	p.up.SetParams(up)
	p.down.SetParams(down)
	r.mu.Lock()
	p.profile = name
	o := p.room.peers[1-p.side]
	r.mu.Unlock()
	send(p.conn, map[string]any{"t": "cond", "profile": name, "up": p.up.Params(), "down": p.down.Params()})
	if o != nil {
		send(o.conn, map[string]any{"t": "peerCond", "profile": name, "up": p.up.Params(), "down": p.down.Params()})
	}
}

func (r *Relay) remove(p *peer) {
	r.mu.Lock()
	rm := p.room
	rm.peers[p.side] = nil
	o := rm.peers[1-p.side]
	if o == nil {
		delete(r.rooms, rm.name)
	}
	r.mu.Unlock()
	p.up.Close()
	p.down.Close()
	if o != nil {
		send(o.conn, map[string]any{"t": "peerLeft"})
	}
	r.log.Info("duel leave", "room", rm.name, "side", p.side, "name", p.name)
}
