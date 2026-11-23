// Package server runs the authoritative game: one room, a fixed-rate tick
// loop, per-client input buffers, snapshots and the Lab settings.
package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"slices"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"netcodelab/net/codec"
	"netcodelab/net/cond"
	"netcodelab/net/transport"
	"netcodelab/sim"
)

// TargetInputBuffer is the playout depth the server tries to keep per client.
// Above TargetInputBuffer+2 it consumes two inputs in one tick to catch up.
const TargetInputBuffer = 1

var teamNames = [2]string{"blue", "orange"}

// CondPair is the conditioner setting of one client: up = client->server.
type CondPair struct {
	Up   cond.Params `json:"up"`
	Down cond.Params `json:"down"`
}

// DefaultCond gives 40 ms RTT (A.1).
func DefaultCond() CondPair {
	return CondPair{Up: cond.Params{DelayMs: 20}, Down: cond.Params{DelayMs: 20}}
}

type Room struct {
	log        *slog.Logger
	start      time.Time
	m          *sim.Map
	params     sim.Params
	adminToken string

	mu           sync.Mutex
	settings     Settings
	presetID     string
	clients      map[uint8]*Client
	defCond      CondPair
	sendAcc      int
	durs         []float64 // tick processing time (ms), recent ticks
	lates        []float64 // how late each tick started vs its schedule (ms)
	lateMax      float64   // worst start lateness since start (ms)
	catchUpTicks uint64    // ticks that started more than one period late
	lastStallNs  int64     // start time (since r.start) of the last late tick
	wbuf         codec.Writer

	tick      atomic.Uint32
	hist      *history
	pool      bufPool
	ents      []codec.Entity // zero-alloc loop scratch
	dbg       codec.Debug
	snap      codec.Snapshot
	timingOn  hist // P26 shot timing error with sub-tick on
	timingOff hist // ... and quantised to the tick
	tickHist  hist // whole-window tick processing time
	lateHist  hist // whole-window tick start lateness
	round     roundState
	teamScore [2]int
	spawnSeq  int
	tickNowMs float64 // server time at the start of the current tick
	outbox    []any   // control messages produced inside a tick, sent after unlock

	tickStartNs    atomic.Int64 // since start
	periodNs       atomic.Int64
	tickRate       atomic.Int32
	scheduleResets atomic.Uint64
	naiveLoop      atomic.Bool
}

func NewRoom(log *slog.Logger, adminToken string) *Room {
	r := &Room{
		log: log, start: time.Now(), m: sim.Courtyard(), params: sim.DefaultParams(),
		adminToken: adminToken, settings: DefaultSettings(), presetID: "P01",
		clients: map[uint8]*Client{}, defCond: DefaultCond(), hist: newHistory(),
	}
	r.setRate(r.settings.TickRate)
	return r
}

func (r *Room) setRate(hz int) {
	r.tickRate.Store(int32(hz))
	r.periodNs.Store(int64(time.Second) / int64(hz))
}

// NowMs is server monotonic time in ms since start.
func (r *Room) NowMs() float64 { return float64(time.Since(r.start).Nanoseconds()) / 1e6 }

// Client is one connected player.
type Client struct {
	room *Room
	id   uint8
	name string
	team uint8
	conn transport.Conn
	ep   codec.Endpoint
	up   *cond.Link
	down *cond.Link

	mu            sync.Mutex // input buffer, written by the up-link goroutine
	inbuf         map[uint32]sim.Cmd
	lastProcessed uint32
	lastInput     sim.Input
	started       bool
	starved       uint32
	held          uint32 // ticks during/just after a host stall with no input: player held, not repeated
	skipped       uint32 // inputs never received (loss beyond redundancy)
	redundant     uint64 // input copies that arrived after the original
	inputLead     int8
	ackedTick     uint32
	ackedBaseline uint8
	recvMs        map[uint32]float64 // arrival time of fire inputs (shot id = input seq), for P11
	claims        []codec.Claim
	reportRTT     float64 // client-reported (clock sync) RTT, from {t:"report"}
	reportFPS     float64
	reportLoss    float64
	reportJitter  float64

	bytes    byteCounters
	entsSent atomic.Uint32 // entities in the last snapshot (P28)

	// owned by the tick loop (room.mu)
	spectator      bool
	state          sim.State
	health         uint8
	alive          bool
	life           uint8
	respawnAtMs    float64
	kills, deaths  int
	shots, hits    int
	lastFireSeq    uint32
	fires          []fire
	events         []pendingEvent
	rejectedClaims int
	snapLast       uint32
	snapBuf        uint8
}

func (r *Room) checkToken(tok string) bool {
	return r.adminToken != "" && subtle.ConstantTimeCompare([]byte(tok), []byte(r.adminToken)) == 1
}

// ---- tick loop ----

// Run ticks until ctx is done. The tick rate can change between ticks.
func (r *Room) Run(ctx context.Context) {
	next := time.Now()
	statsAt := next.Add(time.Second)
	for ctx.Err() == nil {
		period := time.Duration(r.periodNs.Load())
		next = next.Add(period)
		if d := time.Until(next); d > 0 {
			time.Sleep(d)
		} else if -d > time.Second {
			// Stalled for over a second (laptop sleep): drop the missed ticks.
			// Clients resync their pacer on the tick jump.
			r.scheduleResets.Add(1)
			next = time.Now()
		}
		// Shorter stalls: the missed ticks run back to back (fixed-timestep
		// catch-up), so the tick count stays tied to time and the clients'
		// tick estimate stays right. Dropping them made the clients' pacer
		// pause and starved the input buffer (DECISIONS 22).
		late := time.Since(next)
		if late > 3*period {
			r.log.Warn("tick started late", "lateMs", float64(late.Microseconds())/1000, "budgetMs", float64(period.Microseconds())/1000)
		}
		r.step(float64(late.Nanoseconds()) / 1e6)
		if time.Now().After(statsAt) {
			statsAt = statsAt.Add(time.Second)
			r.sendStats()
		}
	}
}

func (r *Room) step(lateMs float64) {
	t0 := time.Now()
	r.mu.Lock()
	r.lates = append(r.lates, lateMs)
	r.lateMax = max(r.lateMax, lateMs)
	tick := r.tick.Add(1)
	r.tickStartNs.Store(t0.Sub(r.start).Nanoseconds())
	s := r.settings
	dt := sim.DtForRate(s.TickRate)
	// A catch-up tick runs immediately after a host stall (the scheduler woke
	// us late). The client was probably stalled too, so its input for this tick
	// may not exist yet: such ticks hold the player instead of repeating input.
	period := r.periodNs.Load()
	if lateMs*1e6 > float64(period) {
		r.catchUpTicks++
		r.lastStallNs = t0.Sub(r.start).Nanoseconds()
	}
	nowNs := t0.Sub(r.start).Nanoseconds()
	r.tickNowMs = float64(nowNs) / 1e6
	for _, c := range r.clients {
		if !c.spectator && !c.alive && r.tickNowMs >= c.respawnAtMs {
			r.respawn(c)
		}
	}
	for _, c := range r.clients {
		if c.spectator {
			continue
		}
		// Inputs the client sent during a stall wait in the socket and then
		// pass the uplink conditioner, so for one uplink delay (+ jitter + 2
		// ticks) after a stall an empty buffer is still the stall's effect.
		up := c.up.Params()
		grace := int64((up.DelayMs+up.JitterMs)*1e6) + 2*period
		before := c.starved
		c.simulate(dt, r.lastStallNs > 0 && nowNs-r.lastStallNs <= grace, s)
		if c.starved != before {
			r.log.Debug("input starvation", "id", c.id, "tick", tick, "msSinceStall", float64(nowNs-r.lastStallNs)/1e6, "lateMs", lateMs)
		}
	}
	for _, c := range r.clients {
		c.mu.Lock()
		claims := c.claims
		c.claims = nil
		c.mu.Unlock()
		if len(claims) > 0 {
			r.processClaims(c, claims, tick, s)
		}
	}
	// History holds the state after this tick's movement; shots fired this
	// tick are resolved against it (and earlier ticks when rewinding).
	r.hist.record(tick, r.tickNowMs, r.clients, s.Loop == "naive")
	for _, c := range r.clients {
		for _, f := range c.fires {
			if c.alive {
				r.resolveFire(c, f, tick, r.tickNowMs, s)
			}
		}
		c.fires = c.fires[:0]
	}
	r.updateRound(r.tickNowMs)
	r.sendAcc += s.SendRate
	if r.sendAcc >= s.TickRate {
		r.sendAcc -= s.TickRate
		r.sendSnapshots(tick, s, r.NowMs())
	}
	d := float64(time.Since(t0).Nanoseconds()) / 1e6
	budget := float64(period) / 1e6
	r.tickHist.add(d, budget)
	r.lateHist.add(lateMs, budget)
	r.durs = append(r.durs, d)
	if len(r.durs) > 4*s.TickRate {
		r.durs = r.durs[len(r.durs)-4*s.TickRate:]
	}
	if len(r.lates) > 4*s.TickRate {
		r.lates = r.lates[len(r.lates)-4*s.TickRate:]
	}
	out := r.outbox
	r.outbox = nil
	r.mu.Unlock()
	for _, m := range out {
		r.broadcast(m)
	}
}

// apply runs one input for this player. Dead players do not move; in trust
// mode the position comes from the client's claims instead (A.5). A fire
// input is queued for resolution after every player has moved this tick.
func (c *Client) apply(cmd sim.Cmd, dt sim.Fx, set Settings, real bool) {
	r := c.room
	if !c.alive || set.Authority == "trust" {
		delete(c.recvMs, cmd.Seq)
		return
	}
	prev := c.state
	sim.Step(r.m, &c.state, cmd.In, dt, &r.params)
	if !real || cmd.In.Buttons&sim.BtnFire == 0 {
		return
	}
	recv := c.recvMs[cmd.Seq]
	delete(c.recvMs, cmd.Seq)
	if c.lastFireSeq != 0 && cmd.Seq-c.lastFireSeq < FireCooldownTicks(set.TickRate) {
		return
	}
	c.lastFireSeq = cmd.Seq
	c.fires = append(c.fires, fire{cmd: cmd, prev: prev, state: c.state, recvMs: recv})
}

// simulate consumes this tick's input(s) from the playout buffer (B.4 rule 3).
func (c *Client) simulate(dt sim.Fx, afterStall bool, set Settings) {
	c.mu.Lock()
	if !c.started {
		// Prime the playout buffer: start one input deeper than the target so
		// normal timing noise does not empty it.
		if len(c.inbuf) < TargetInputBuffer+1 {
			c.snapLast, c.snapBuf = c.lastProcessed, uint8(len(c.inbuf))
			c.mu.Unlock()
			return
		}
		c.started = true
	}
	n := 1
	if len(c.inbuf) > TargetInputBuffer+2 {
		n = 2
	}
	for i := 0; i < n; i++ {
		cmd, ok := c.inbuf[c.lastProcessed+1]
		if !ok && len(c.inbuf) > 0 {
			// A gap the redundant copies did not cover: jump to the oldest we have.
			low := uint32(0)
			for s := range c.inbuf {
				if low == 0 || s < low {
					low = s
				}
			}
			cmd, ok = c.inbuf[low]
			c.skipped += low - c.lastProcessed - 1
		}
		if !ok && i > 0 {
			break
		}
		if !ok && afterStall {
			// Host stall: hold this player for the tick and count it. Inputs
			// stay strictly sequential, so this causes no misprediction.
			c.held++
			break
		}
		if !ok {
			// Buffer empty on an on-time tick: repeat the last input and
			// count it (A.14). The client will see a correction.
			c.starved++
			in := c.lastInput
			in.Buttons &^= sim.BtnFire | sim.BtnJump
			c.apply(sim.Cmd{In: in}, dt, set, false)
			break
		}
		delete(c.inbuf, cmd.Seq)
		c.lastProcessed = cmd.Seq
		c.lastInput = cmd.In
		c.apply(cmd, dt, set, true)
	}
	c.snapLast, c.snapBuf = c.lastProcessed, uint8(min(len(c.inbuf), 255))
	c.mu.Unlock()
}

func (r *Room) sendSnapshots(tick uint32, s Settings, now float64) {
	naive := s.Loop == "naive"
	// P19: the zero-alloc loop reuses room-owned slices and pooled buffers;
	// the naive loop allocates per tick, per client and per entity. Both put
	// the same bytes on the wire (TestLoopModesSameBytes).
	var ents []codec.Entity
	var dbg *codec.Debug
	if naive {
		dbg = &codec.Debug{}
	} else {
		ents = r.ents[:0]
		dbg = &r.dbg
		dbg.Players = dbg.Players[:0]
	}
	for _, c := range r.clients {
		if c.spectator {
			continue
		}
		e := codec.Entity{ID: c.id, Team: c.team, Pos: c.state.Pos, Yaw: c.state.Yaw, Pitch: c.state.Pitch, Health: c.health}
		if !c.alive {
			e.Anim |= codec.AnimDead
		}
		if c.state.OnGround {
			e.Anim |= codec.AnimOnGround
		}
		if c.state.Vel[0] != 0 || c.state.Vel[2] != 0 {
			e.Anim |= codec.AnimMoving
		}
		if naive {
			ep := new(codec.Entity) // one heap object per entity per tick
			*ep = e
			ents = append(ents, *ep)
		} else {
			ents = append(ents, e)
		}
		dbg.Players = append(dbg.Players, codec.DebugPos{ID: c.id, Pos: c.state.Pos})
	}
	// Stable order (by id) so the bytes do not depend on map iteration;
	// delta encoding (P27) relies on it too.
	slices.SortFunc(ents, func(a, b codec.Entity) int { return int(a.ID) - int(b.ID) })
	slices.SortFunc(dbg.Players, func(a, b codec.DebugPos) int { return int(a.ID) - int(b.ID) })
	if !naive {
		r.ents = ents
	}
	dbg.ServerTick = tick
	for _, c := range r.clients {
		var snap *codec.Snapshot
		if naive {
			snap = &codec.Snapshot{}
		} else {
			snap = &r.snap
			snap.Entities, snap.Events = snap.Entities[:0], snap.Events[:0]
		}
		r.fillSnapshot(c, snap, tick, now, ents, s)
		c.entsSent.Store(uint32(len(snap.Entities)))
		var w codec.Writer
		if !naive {
			w.B = r.pool.get()
		}
		codec.AppendSnapshot(&w, c.ep.NextHeader(codec.TSnapshot, now), snap)
		c.down.Push(w.B)
		if s.TruthGhost {
			var dw codec.Writer
			if !naive {
				dw.B = r.pool.get()
			}
			codec.AppendDebug(&dw, c.ep.NextHeader(codec.TDebug, now), dbg)
			c.down.Push(dw.B)
		}
	}
}

// fillSnapshot sets everything in snap for client c except the header.
func (r *Room) fillSnapshot(c *Client, snap *codec.Snapshot, tick uint32, now float64, ents []codec.Entity, s Settings) {
	c.mu.Lock()
	starved, lead, acked := c.starved, c.inputLead, c.ackedTick
	c.mu.Unlock()
	snap.ServerTick, snap.ServerTimeMs, snap.LastProcessedInputSeq = tick, now, c.snapLast
	snap.Own = codec.OwnState{State: c.state, Health: c.health, InputBuffer: c.snapBuf, Starved: uint16(starved), InputLead: lead,
		Dead: !c.alive && !c.spectator, Life: c.life}
	snap.BaselineID = 0
	// Events ride every snapshot until the client acks one that carried them.
	keep := c.events[:0]
	for _, pe := range c.events {
		if (pe.firstTick != 0 && acked >= pe.firstTick) || now-pe.addedMs > eventMaxAgeMs {
			continue
		}
		if pe.firstTick == 0 {
			pe.firstTick = tick
		}
		keep = append(keep, pe)
		snap.Events = append(snap.Events, pe.ev)
	}
	c.events = keep
	cell := sim.FromFloat(float64(s.InterestCellM))
	filter := s.Interest && !c.spectator
	cx, cz := floorDiv(c.state.Pos[0], cell), floorDiv(c.state.Pos[2], cell)
	for _, e := range ents {
		if e.ID == c.id {
			continue
		}
		if filter {
			ex, ez := floorDiv(e.Pos[0], cell), floorDiv(e.Pos[2], cell)
			if ex-cx > 1 || cx-ex > 1 || ez-cz > 1 || cz-ez > 1 {
				continue
			}
		}
		snap.Entities = append(snap.Entities, e)
	}
}

// ---- datagrams from the conditioner ----

// onDatagram runs on the client's up-link goroutine, after the simulated delay.
func (c *Client) onDatagram(b []byte) {
	r := c.room
	now := r.NowMs()
	rd := codec.Reader{B: b}
	h := rd.Header()
	if rd.Err != nil {
		return
	}
	if dup, _ := c.ep.OnReceive(h, now); dup {
		return
	}
	switch h.Type {
	case codec.TInput:
		var in codec.Input
		codec.ReadInput(&rd, &in)
		if rd.Err != nil || len(in.Cmds) == 0 {
			return
		}
		tick := r.tick.Load()
		c.mu.Lock()
		for _, cmd := range in.Cmds {
			if cmd.Seq <= c.lastProcessed {
				c.redundant++
				continue
			}
			if _, ok := c.inbuf[cmd.Seq]; ok {
				c.redundant++
				continue
			}
			if len(c.inbuf) < 128 {
				c.inbuf[cmd.Seq] = cmd
				if cmd.In.Buttons&sim.BtnFire != 0 {
					c.recvMs[cmd.Seq] = now
				}
			}
		}
		lead := int64(in.Cmds[len(in.Cmds)-1].ClientTick) - int64(tick)
		c.inputLead = int8(max(-128, min(127, lead)))
		c.mu.Unlock()
	case codec.TClaim:
		var cl codec.Claim
		codec.ReadClaim(&rd, &cl)
		if rd.Err != nil {
			return
		}
		c.mu.Lock()
		if len(c.claims) < 64 {
			c.claims = append(c.claims, cl)
		}
		c.mu.Unlock()
	case codec.TPing:
		var p codec.Ping
		codec.ReadPing(&rd, &p)
		if rd.Err != nil {
			return
		}
		tick := r.tick.Load()
		period := r.periodNs.Load()
		since := time.Since(r.start).Nanoseconds() - r.tickStartNs.Load()
		frac := min(max(since*65536/period, 0), 65535)
		send := r.NowMs()
		var w codec.Writer
		if !r.naiveLoop.Load() {
			w.B = r.pool.get()
		}
		codec.AppendPong(&w, c.ep.NextHeader(codec.TPong, send), &codec.Pong{
			ClientSendMs: p.ClientSendMs, ServerRecvMs: now, ServerSendMs: send,
			ServerTick: tick, TickFrac: uint16(frac), TickRate: uint16(r.tickRate.Load()),
		})
		c.down.Push(w.B)
	case codec.TSnapshotAck:
		var a codec.SnapshotAck
		codec.ReadSnapshotAck(&rd, &a)
		if rd.Err != nil {
			return
		}
		c.mu.Lock()
		if a.ServerTick > c.ackedTick {
			c.ackedTick, c.ackedBaseline = a.ServerTick, a.BaselineID
		}
		c.mu.Unlock()
	}
}

// ---- connections and control ----

type ctrlIn struct {
	T        string          `json:"t"`
	Name     string          `json:"name,omitempty"`
	Token    string          `json:"token,omitempty"`
	Settings json.RawMessage `json:"settings,omitempty"`
	ID       string          `json:"id,omitempty"`
	Target   int             `json:"target,omitempty"` // cond: player id, 0 = self
	All      bool            `json:"all,omitempty"`    // cond: every client and the default for new joins
	Up       *cond.Params    `json:"up,omitempty"`
	Down     *cond.Params    `json:"down,omitempty"`
	Text     string          `json:"text,omitempty"`
	Spectate bool            `json:"spectate,omitempty"` // join as presenter/spectator: no player entity
	RTTMs    float64         `json:"rttMs,omitempty"`    // report
	JitterMs float64         `json:"jitterMs,omitempty"` // report
	LossPct  float64         `json:"lossPct,omitempty"`  // report
	FPS      float64         `json:"fps,omitempty"`      // report
	// shotSeen (P11, target side)
	ShooterID int     `json:"shooterId,omitempty"`
	ShotSeq   uint32  `json:"shotSeq,omitempty"`
	RecvMs    float64 `json:"recvServerMs,omitempty"`
	InterpMs  float64 `json:"interpMs,omitempty"`
	FrameMs   float64 `json:"frameServerMs,omitempty"`
}

type presetOut struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Section string `json:"section"`
	Banner  string `json:"banner"`
	Built   bool   `json:"built"`
}

func presetList() []presetOut {
	var out []presetOut
	for _, p := range Presets() {
		out = append(out, presetOut{p.ID, p.Title, p.Section, p.Banner, p.Built})
	}
	return out
}

func bannerOf(id string) string {
	for _, p := range Presets() {
		if p.ID == id {
			return p.Banner
		}
	}
	return ""
}

func (r *Room) send(c *Client, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		r.log.Error("marshal", "err", err)
		return
	}
	c.bytes.downControl.Add(uint64(len(b)))
	if err := c.conn.SendControl(b); err != nil {
		r.log.Debug("control send", "id", c.id, "err", err)
	}
}

// broadcast sends to every client; call without r.mu held.
func (r *Room) broadcast(v any) {
	r.mu.Lock()
	cs := make([]*Client, 0, len(r.clients))
	for _, c := range r.clients {
		cs = append(cs, c)
	}
	r.mu.Unlock()
	for _, c := range cs {
		r.send(c, v)
	}
}

func (r *Room) errorTo(c *Client, msg string) {
	r.send(c, map[string]any{"t": "error", "msg": msg})
}

// HandleConn runs one connection until it closes. Called per transport connection.
func (r *Room) HandleConn(conn transport.Conn) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	jctx, jcancel := context.WithTimeout(ctx, 15*time.Second)
	var join ctrlIn
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

	c, err := r.addClient(conn, join.Name, join.Spectate)
	if err != nil {
		conn.Close(err.Error())
		return
	}
	r.log.Info("join", "id", c.id, "name", c.name, "team", c.teamName(), "transport", conn.Kind(), "remote", conn.RemoteAddr())
	defer r.removeClient(c)
	r.welcome(c)
	r.broadcastPlayers()

	for {
		m, err := conn.Recv(ctx)
		if err != nil {
			return
		}
		if !m.Control {
			c.bytes.upDatagram.Add(uint64(len(m.Data)))
			c.up.Push(m.Data)
			continue
		}
		var in ctrlIn
		if err := json.Unmarshal(m.Data, &in); err != nil {
			r.errorTo(c, "bad json")
			continue
		}
		if in.T == "debugpos" {
			r.relayDebug(c, m.Data)
			continue
		}
		r.handleControl(c, in)
	}
}

func (r *Room) addClient(conn transport.Conn, name string, spectate bool) (*Client, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var id uint8
	for i := 1; i < 255; i++ {
		if _, ok := r.clients[uint8(i)]; !ok {
			id = uint8(i)
			break
		}
	}
	if id == 0 {
		return nil, errFull
	}
	var count [2]int
	for _, o := range r.clients {
		if !o.spectator {
			count[o.team]++
		}
	}
	team := uint8(0)
	if count[1] < count[0] {
		team = 1
	}
	if len(name) > 24 {
		name = name[:24]
	}
	if name == "" {
		name = "player"
	}
	c := &Client{room: r, id: id, name: name, team: team, conn: conn, inbuf: map[uint32]sim.Cmd{}, recvMs: map[uint32]float64{},
		spectator: spectate}
	if !spectate {
		r.respawn(c) // spawn point, full health, life 1
	}
	ordered := conn.Kind() == transport.KindWS
	seed := uint64(time.Now().UnixNano()) ^ uint64(id)<<32
	c.up = cond.NewLink(r.defCond.Up, ordered, seed, c.onDatagram)
	deliver := func(b []byte) {
		c.bytes.downDatagram.Add(uint64(len(b)))
		if len(b) > 0 && b[0] == codec.TSnapshot {
			c.bytes.snapshots.Add(1)
		}
		if err := conn.SendDatagram(b); err != nil {
			r.log.Debug("datagram send", "id", id, "err", err)
		}
	}
	c.down = cond.NewLink(r.defCond.Down, ordered, seed+1, deliver)
	c.down.Release = r.pool.put
	c.syncRTT()
	r.clients[id] = c
	return c, nil
}

func (r *Room) removeClient(c *Client) {
	r.mu.Lock()
	delete(r.clients, c.id)
	r.mu.Unlock()
	c.up.Close()
	c.down.Close()
	c.conn.Close("bye")
	r.log.Info("leave", "id", c.id, "name", c.name)
	r.broadcastPlayers()
}

type errString string

func (e errString) Error() string { return string(e) }

const errFull = errString("room full")

func stateJSON(s sim.State) map[string]any {
	return map[string]any{"x": s.Pos[0], "y": s.Pos[1], "z": s.Pos[2], "vx": s.Vel[0], "vy": s.Vel[1], "vz": s.Vel[2],
		"onGround": s.OnGround, "yaw": s.Yaw, "pitch": s.Pitch}
}

func (c *Client) teamName() string {
	if c.spectator {
		return "spectator"
	}
	return teamNames[c.team]
}

func (r *Room) welcome(c *Client) {
	r.mu.Lock()
	msg := map[string]any{
		"t": "welcome", "protocolVersion": ProtocolVersion,
		"id": c.id, "name": c.name, "team": c.teamName(), "spectator": c.spectator, "transport": c.conn.Kind(),
		"scorecard": scorecard(r.settings), "round": r.roundMsg(), "life": c.life,
		"fireCooldownTicks": FireCooldownTicks(r.settings.TickRate),
		"rules": map[string]any{"damageBody": DamageBody, "damageHead": DamageHead, "respawnMs": RespawnMs,
			"roundMs": RoundMs, "intermissionMs": IntermissionMs, "rpm": 600, "historyKeepMs": historyKeepMs},
		"settings": r.settings, "presetId": r.presetID, "banner": bannerOf(r.presetID),
		"supportedSettings": SupportedSettings(), "presets": presetList(),
		"cond": CondPair{Up: c.up.Params(), Down: c.down.Params()},
		"tick": r.tick.Load(), "tickRate": r.settings.TickRate, "serverTimeMs": r.NowMs(),
		"spawn":              stateJSON(c.state),
		"map":                "/shared/map.json",
		"adminTokenRequired": true,
	}
	r.mu.Unlock()
	r.send(c, msg)
}

func (r *Room) broadcastPlayers() {
	r.mu.Lock()
	type p struct {
		ID   uint8  `json:"id"`
		Name string `json:"name"`
		Team string `json:"team"`
	}
	var ps []p
	for _, c := range r.clients {
		ps = append(ps, p{c.id, c.name, c.teamName()})
	}
	r.mu.Unlock()
	sort.Slice(ps, func(i, j int) bool { return ps[i].ID < ps[j].ID })
	r.broadcast(map[string]any{"t": "players", "players": ps})
}

func (r *Room) broadcastSettings() {
	r.mu.Lock()
	msg := map[string]any{"t": "settings", "settings": r.settings, "presetId": r.presetID, "banner": bannerOf(r.presetID),
		"scorecard": scorecard(r.settings), "fireCooldownTicks": FireCooldownTicks(r.settings.TickRate)}
	r.mu.Unlock()
	r.broadcast(msg)
}

func (r *Room) applySettings(s Settings, preset string) {
	r.mu.Lock()
	rateChanged := s.TickRate != r.settings.TickRate
	r.settings, r.presetID = s, preset
	r.sendAcc = 0
	r.params.SpeedScale = sim.FromFloat(s.SpeedScale)
	r.naiveLoop.Store(s.Loop == "naive")
	applyMemLimit(s.GoMemLimitMB)
	if rateChanged {
		r.setRate(s.TickRate)
		r.durs = r.durs[:0]
		r.lates = r.lates[:0]
	}
	r.mu.Unlock()
	r.log.Info("settings", "preset", preset, "tickRate", s.TickRate, "sendRate", s.SendRate, "predict", s.Predict, "reconcile", s.Reconcile)
	r.broadcastSettings()
}

func (r *Room) handleControl(c *Client, in ctrlIn) {
	switch in.T {
	case "lab":
		if !r.checkToken(in.Token) {
			r.errorTo(c, "lab: bad admin token")
			return
		}
		r.mu.Lock()
		cur := r.settings
		r.mu.Unlock()
		s, err := cur.Merge(in.Settings)
		if err != nil {
			r.errorTo(c, "lab: "+err.Error())
			return
		}
		r.applySettings(s, "custom")
	case "preset":
		if !r.checkToken(in.Token) {
			r.errorTo(c, "preset: bad admin token")
			return
		}
		for _, p := range Presets() {
			if p.ID == in.ID {
				if !p.Built {
					r.errorTo(c, "preset "+p.ID+" is not built yet")
					return
				}
				s := DefaultSettings()
				p.apply(&s)
				cp := DefaultCond()
				if p.cond != nil {
					cp = p.cond()
				}
				r.setCondAll(cp)
				r.applySettings(s, p.ID)
				return
			}
		}
		r.errorTo(c, "unknown preset "+in.ID)
	case "cond":
		r.handleCond(c, in)
	case "report":
		c.mu.Lock()
		c.reportRTT, c.reportJitter, c.reportLoss, c.reportFPS = in.RTTMs, in.JitterMs, in.LossPct, in.FPS
		c.mu.Unlock()
	case "statsReset":
		if !r.checkToken(in.Token) {
			r.errorTo(c, "statsReset: bad admin token")
			return
		}
		r.tickHist.reset()
		r.lateHist.reset()
		r.timingOn.reset()
		r.timingOff.reset()
		r.send(c, map[string]any{"t": "statsReset", "serverTimeMs": r.NowMs()})
	case "shotSeen":
		// P11: the target's client reports when it received and drew a shot's
		// effect (server-clock ms); relay it to the shooter, who owns the bar.
		r.relayShotSeen(c, in)
	case "history":
		r.send(c, r.historyMsg())
	case "chat":
		t := in.Text
		if len(t) > 200 {
			t = t[:200]
		}
		r.broadcast(map[string]any{"t": "chat", "from": c.name, "id": c.id, "text": t})
	default:
		r.errorTo(c, "unknown control type "+in.T)
	}
}

// handleCond changes conditioner settings. A player may change their own
// links without the token; other players or "all" need the admin token.
func (r *Room) handleCond(c *Client, in ctrlIn) {
	self := !in.All && (in.Target == 0 || in.Target == int(c.id))
	if !self && !r.checkToken(in.Token) {
		r.errorTo(c, "cond: admin token required for other players")
		return
	}
	var targets []*Client
	r.mu.Lock()
	switch {
	case in.All:
		for _, o := range r.clients {
			targets = append(targets, o)
		}
		if in.Up != nil {
			r.defCond.Up = in.Up.Clamp()
		}
		if in.Down != nil {
			r.defCond.Down = in.Down.Clamp()
		}
	case self:
		targets = []*Client{c}
	default:
		if o, ok := r.clients[uint8(in.Target)]; ok {
			targets = []*Client{o}
		}
	}
	r.mu.Unlock()
	if len(targets) == 0 {
		r.errorTo(c, "cond: no such player")
		return
	}
	for _, t := range targets {
		if in.Up != nil {
			t.up.SetParams(*in.Up)
		}
		if in.Down != nil {
			t.down.SetParams(*in.Down)
		}
		t.syncRTT()
		r.send(t, map[string]any{"t": "cond", "cond": CondPair{Up: t.up.Params(), Down: t.down.Params()}, "by": c.id})
	}
}

// setCondAll applies a conditioner pair to every client and as the default.
func (r *Room) setCondAll(cp CondPair) {
	r.mu.Lock()
	r.defCond = CondPair{Up: cp.Up.Clamp(), Down: cp.Down.Clamp()}
	cs := make([]*Client, 0, len(r.clients))
	for _, c := range r.clients {
		cs = append(cs, c)
	}
	r.mu.Unlock()
	for _, c := range cs {
		c.up.SetParams(cp.Up)
		c.down.SetParams(cp.Down)
		c.syncRTT()
		r.send(c, map[string]any{"t": "cond", "cond": CondPair{Up: c.up.Params(), Down: c.down.Params()}, "by": 0})
	}
}

// ---- 1 Hz stats (control path, not the hot path) ----

type TickStats struct {
	Samples         int     `json:"samples"`
	BudgetMs        float64 `json:"budgetMs"`
	P50Ms           float64 `json:"p50Ms"`
	P99Ms           float64 `json:"p99Ms"`
	MaxMs           float64 `json:"maxMs"`
	WithinBudgetPct float64 `json:"withinBudgetPct"`
}

func tickStats(durs []float64, rate int) TickStats {
	n := min(len(durs), rate)
	d := slices.Clone(durs[len(durs)-n:])
	budget := 1000 / float64(rate)
	ts := TickStats{Samples: n, BudgetMs: budget}
	if n == 0 {
		return ts
	}
	sort.Float64s(d)
	within := 0
	for _, v := range d {
		if v <= budget {
			within++
		}
	}
	ts.P50Ms = d[n/2]
	ts.P99Ms = d[min(n-1, n*99/100)]
	ts.MaxMs = d[n-1]
	ts.WithinBudgetPct = 100 * float64(within) / float64(n)
	return ts
}

func (r *Room) sendStats() {
	r.mu.Lock()
	ts := tickStats(r.durs, r.settings.TickRate)
	late := tickStats(r.lates, r.settings.TickRate)
	lateMax := r.lateMax
	catchUps := r.catchUpTicks
	tick := r.tick.Load()
	s := r.settings
	cs := make([]*Client, 0, len(r.clients))
	for _, c := range r.clients {
		cs = append(cs, c)
	}
	r.mu.Unlock()
	// Whole window since start or the last {t:"statsReset"}: tick time and
	// start lateness kept separate (slow tick vs late scheduler), plus GC.
	window := map[string]any{"tickMs": r.tickHist.stats(), "startLateMs": r.lateHist.stats(), "gc": readGC(),
		"shotTimingErrMs": map[string]any{"subtickOn": r.timingOn.stats(), "quantised": r.timingOff.stats(),
			"note": "|time the server used for the shot - click time|; over budget = more than one tick"}}
	// Cost meters (P12): per-client rates first, then the room total.
	nowMs := r.NowMs()
	rates := make(map[uint8]map[string]float64, len(cs))
	var egress, ingress float64
	for _, c := range cs {
		rt := c.bytes.rates(nowMs)
		rates[c.id] = rt
		egress += rt["downDatagramBps"] + rt["downControlBps"]
		ingress += rt["upDatagramBps"] + rt["upControlBps"]
	}
	cost := map[string]any{"tickMsP50": ts.P50Ms, "tickMsP99": ts.P99Ms, "totalEgressBps": egress, "totalIngressBps": ingress,
		"totalEgressKbps": egress * 8 / 1000, "clients": len(cs), "note": "payload bytes; transport framing not counted"}
	for _, c := range cs {
		es := c.ep.Snapshot()
		c.mu.Lock()
		you := map[string]any{
			"inputBuffer": len(c.inbuf), "starved": c.starved, "heldOnStall": c.held, "skippedInputs": c.skipped,
			"redundantInputs": c.redundant, "lastProcessedInputSeq": c.lastProcessed, "inputLead": c.inputLead,
			"ackedSnapshotTick": c.ackedTick,
		}
		c.mu.Unlock()
		upLoss := 0.0
		if tot := es.Received + es.RemoteGaps; tot > 0 {
			upLoss = 100 * float64(es.RemoteGaps) / float64(tot)
		}
		you["upLossPct"] = upLoss
		you["serverAckRttMs"] = es.RTTMs
		you["downSent"], you["downAcked"], you["downLost"] = es.Sent, es.Acked, es.Lost
		you["cond"] = CondPair{Up: c.up.Params(), Down: c.down.Params()}
		you["entitiesPerSnapshot"] = c.entsSent.Load()
		you["condStats"] = map[string]cond.Stats{"up": c.up.Stats(), "down": c.down.Stats()}
		r.send(c, map[string]any{
			"t": "stats", "serverTick": tick, "serverTimeMs": r.NowMs(), "tickRate": s.TickRate, "sendRate": s.SendRate,
			"tick": ts, "tickStartLate": map[string]any{"p50Ms": late.P50Ms, "p99Ms": late.P99Ms, "maxMs": late.MaxMs, "maxSinceStartMs": lateMax, "catchUpTicks": catchUps, "scheduleResets": r.scheduleResets.Load()},
			"players": len(cs), "you": you,
			"window": window, "cost": cost, "youCost": rates[c.id],
			"budgetEst": budgetEst(s, CondPair{Up: c.up.Params(), Down: c.down.Params()}),
		})
	}
	r.broadcast(r.scoreboardMsg())
}

// ProtocolVersion is sent in welcome; bump on wire changes.
const ProtocolVersion = 2

// syncRTT gives each ordered (TCP-modelled) link the other direction's delay,
// so its retransmission model uses the full simulated RTT.
func (c *Client) syncRTT() {
	c.up.SetReverseDelay(c.down.Params().DelayMs)
	c.down.SetReverseDelay(c.up.Params().DelayMs)
}

// floorDiv rounds toward -inf, so every grid cell has the same width.
func floorDiv(a, b int32) int32 {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}
