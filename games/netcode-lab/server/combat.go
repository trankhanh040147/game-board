package server

import (
	"encoding/json"
	"math"

	"netcodelab/net/codec"
	"netcodelab/sim"
)

// Combat rules (B.3): one hitscan rifle, 600 rpm, no spread, body 25, head 100.
const (
	DamageBody      = 25
	DamageHead      = 100
	RespawnMs       = 3000
	RoundMs         = 120_000
	IntermissionMs  = 5000
	historyKeepMs   = 2000 // ring covers the 1 s lag-comp cap and the presenter's 2 s
	maxPendingEvent = 12
	eventMaxAgeMs   = 3000
	traceMaxDist    = 300.0
)

// FireCooldownTicks is the minimum number of inputs between two shots at a
// tick rate: 600 rpm = 100 ms. Clients use the same rule for cosmetics.
func FireCooldownTicks(rate int) uint32 { return uint32((rate + 9) / 10) }

// ---- lag-compensation history (A.10): positions only, never the whole world ----

type histPlayer struct {
	id         uint8
	team       uint8
	pos        [3]sim.Fx
	yaw, pitch int16
	alive      bool
}

type histEntry struct {
	tick    uint32
	timeMs  float64
	players []histPlayer
}

type history struct {
	ring []histEntry
}

func newHistory() *history { return &history{ring: make([]histEntry, 512)} }

func (h *history) record(tick uint32, timeMs float64, clients map[uint8]*Client, naive bool) {
	e := &h.ring[tick%uint32(len(h.ring))]
	e.tick, e.timeMs = tick, timeMs
	if naive {
		e.players = make([]histPlayer, 0, len(clients)) // the allocating loop: a new slice every tick
	} else {
		e.players = e.players[:0]
	}
	for _, c := range clients {
		if c.spectator {
			continue
		}
		e.players = append(e.players, histPlayer{id: c.id, team: c.team, pos: c.state.Pos, yaw: c.state.Yaw, pitch: c.state.Pitch, alive: c.alive})
	}
}

func (h *history) at(tick uint32) *histEntry {
	e := &h.ring[tick%uint32(len(h.ring))]
	if e.tick != tick {
		return nil
	}
	return e
}

func (e *histEntry) find(id uint8) (histPlayer, bool) {
	for _, p := range e.players {
		if p.id == id {
			return p, true
		}
	}
	return histPlayer{}, false
}

// posAt returns player id's feet position at fractional tick t, interpolated
// between the two recorded ticks around it.
func (h *history) posAt(id uint8, t float64) (sim.Vec3, bool) {
	t0 := uint32(math.Floor(t))
	f := t - float64(t0)
	a := h.at(t0)
	if a == nil {
		return sim.Vec3{}, false
	}
	pa, ok := a.find(id)
	if !ok || !pa.alive {
		return sim.Vec3{}, false
	}
	va := sim.VecFromFx(pa.pos)
	if f == 0 {
		return va, true
	}
	if b := h.at(t0 + 1); b != nil {
		if pb, ok := b.find(id); ok && pb.alive {
			vb := sim.VecFromFx(pb.pos)
			return va.Add(vb.Sub(va).Scale(f)), true
		}
	}
	return va, true
}

func toFx(v sim.Vec3) [3]int32 {
	return [3]int32{sim.FromFloat(v[0]), sim.FromFloat(v[1]), sim.FromFloat(v[2])}
}

// ---- events (resent until acked) ----

type pendingEvent struct {
	ev        codec.Event
	firstTick uint32 // first snapshot tick that carried it, 0 = not sent yet
	addedMs   float64
}

func (c *Client) queueEvent(t uint8, data []byte, nowMs float64) {
	if len(c.events) >= maxPendingEvent {
		c.events = c.events[1:]
	}
	c.events = append(c.events, pendingEvent{ev: codec.Event{Type: t, Data: data}, addedMs: nowMs})
}

// ---- shots ----

type fire struct {
	cmd    sim.Cmd
	prev   sim.State // shooter state before the fire input (sub-tick origin)
	state  sim.State // shooter state after applying the fire input
	recvMs float64
}

// hitAt traces the ray against every other alive player of the other team at
// fractional tick t; walls stop it at wallDist.
func (r *Room) hitAt(shooter *Client, o, d sim.Vec3, wallDist, t float64) (uint8, uint8, sim.Vec3) {
	var bestID, bestPart uint8
	var bestPos sim.Vec3
	best := wallDist
	for _, v := range r.clients {
		if v == shooter || v.spectator || v.team == shooter.team {
			continue
		}
		pos, ok := r.hist.posAt(v.id, t)
		if !ok {
			continue
		}
		if dist, part := sim.RayPlayer(o, d, pos); part != sim.HitNone && dist < best {
			best, bestID, bestPart, bestPos = dist, v.id, part, pos
		}
	}
	return bestID, bestPart, bestPos
}

// resolveFire is the server's authoritative shot (A.10, B.4 rule 5): it reads
// only the input (time + direction) and decides from its own history.
func (r *Room) resolveFire(c *Client, f fire, tick uint32, tickStartMs float64, s Settings) {
	rate := float64(s.TickRate)
	now := float64(tick)
	renderT := float64(f.cmd.RenderTick) + float64(f.cmd.RenderFrac)/65536
	var flags uint8
	if f.cmd.RenderTick == 0 {
		renderT = now
	}
	minT := now - float64(s.HistoryMs)*rate/1000
	if renderT < minT {
		renderT, flags = minT, flags|codec.ShotClamped
	}
	if renderT > now {
		renderT, flags = now, flags|codec.ShotClamped
	}
	// P26. The click happened at subtickFrac inside the input's tick. Classic
	// (quantised) handling acts as if it happened when the tick's input was
	// sampled, at the tick's end: the render time is later by (1 - frac)
	// ticks and the ray starts at the end-of-tick position. Sub-tick uses the
	// click time itself and interpolates the shooter's position.
	frac := float64(f.cmd.SubtickFrac) / 65536
	clickT := renderT
	origin := sim.EyePos(f.state.Pos)
	if s.Subtick {
		prev, cur := sim.EyePos(f.prev.Pos), sim.EyePos(f.state.Pos)
		origin = prev.Add(cur.Sub(prev).Scale(frac))
	} else if f.cmd.RenderTick != 0 {
		renderT = min(renderT+(1-frac), now)
	}
	timingErrMs := (renderT - clickT) * 1000 / rate
	usedT := now
	if s.LagComp {
		if s.FavorVictimRttMs > 0 && c.rttMs() > float64(s.FavorVictimRttMs) {
			flags |= codec.ShotFavoured
		} else {
			usedT, flags = renderT, flags|codec.ShotLagComp
		}
	}
	o := origin
	d := sim.AimDir(f.cmd.In.Yaw, f.cmd.In.Pitch)
	wall := sim.TraceMap(r.m, o, d, traceMaxDist)
	hitID, hitPart, _ := r.hitAt(c, o, d, wall, usedT)
	seenID, seenPart, _ := r.hitAt(c, o, d, wall, renderT)

	sr := codec.ShotResult{
		ShotSeq: f.cmd.Seq, ResolveTick: tick, RenderTick: f.cmd.RenderTick, RenderFrac: f.cmd.RenderFrac,
		RewoundTick: uint32(math.Floor(usedT)), RewoundFrac: uint16((usedT - math.Floor(usedT)) * 65535),
		Flags: flags, HitID: hitID, Hitbox: hitPart, SeenID: seenID, SeenHitbox: seenPart,
		WallDistCm: uint32(wall * 100), RecvMs: f.recvMs, TickStartMs: tickStartMs,
		SubtickFrac: f.cmd.SubtickFrac, TimingErrUs: uint16(min(65535, math.Round(math.Abs(timingErrMs)*1000))),
	}
	if f.cmd.RenderTick != 0 {
		if s.Subtick {
			r.timingOn.add(math.Abs(timingErrMs), 1000/rate)
		} else {
			r.timingOff.add(math.Abs(timingErrMs), 1000/rate)
		}
	}
	subject := seenID
	if subject == 0 {
		subject = hitID
	}
	if subject != 0 {
		sp, ok1 := r.hist.posAt(subject, renderT)
		up, ok2 := r.hist.posAt(subject, usedT)
		if ok1 && ok2 {
			sr.SeenPos, sr.UsedPos = toFx(sp), toFx(up)
			sr.MovedCm = uint16(min(65535, math.Round(up.Sub(sp).Len()*100)))
		}
	}
	if hitID != 0 {
		v := r.clients[hitID]
		dmg := uint8(DamageBody)
		if hitPart == sim.HitHead {
			dmg = DamageHead
		}
		sr.Damage = dmg
		killed := r.applyDamage(c, v, dmg, hitPart, f.cmd.Seq, tick, usedT, flags, f.cmd.In)
		sr.VictimHP = v.health
		if killed {
			sr.Flags |= codec.ShotKilled
		}
	}
	c.queueEvent(codec.EvShotResult, sr.Append(nil), tickStartMs)
	c.shots++
	if hitID != 0 {
		c.hits++
	}
}

// applyDamage hurts v and handles the kill. Returns true when v died.
func (r *Room) applyDamage(shooter, v *Client, dmg, part uint8, shotSeq, tick uint32, usedT float64, flags uint8, aim sim.Input) bool {
	now := r.tickNowMs
	if int(v.health) <= int(dmg) {
		v.health = 0
	} else {
		v.health -= dmg
	}
	killed := v.health == 0
	if killed {
		flags |= codec.ShotKilled
	}
	dm := codec.Damage{ShotSeq: shotSeq, ShooterID: shooter.id, Hitbox: part, Damage: dmg, Health: v.health, ResolveTick: tick, Flags: flags}
	v.queueEvent(codec.EvDamage, dm.Append(nil), now)
	if !killed {
		return false
	}
	v.alive = false
	v.deaths++
	shooter.kills++
	r.teamScore[shooter.team]++
	v.respawnAtMs = now + RespawnMs
	hitPos, _ := r.hist.posAt(v.id, usedT)
	de := codec.Death{
		Life: v.life, ShooterID: shooter.id, Hitbox: part, Flags: flags, ShotSeq: shotSeq, ResolveTick: tick,
		RewoundTick: uint32(math.Floor(usedT)), RewoundFrac: uint16((usedT - math.Floor(usedT)) * 65535),
		HitPos: toFx(hitPos), NowPos: v.state.Pos, ShooterPos: shooter.state.Pos,
		ShooterYaw: aim.Yaw, ShooterPitch: aim.Pitch,
		RespawnTick: tick + uint32(RespawnMs*int(r.tickRate.Load())/1000),
	}
	v.queueEvent(codec.EvDeath, de.Append(nil), now)
	r.outbox = append(r.outbox, map[string]any{
		"t": "kill", "killerId": shooter.id, "killer": shooter.name, "victimId": v.id, "victim": v.name,
		"headshot": part == sim.HitHead, "tick": tick, "trust": flags&codec.ShotTrustMode != 0,
		"lagcomp": flags&codec.ShotLagComp != 0,
	})
	return true
}

func (c *Client) rttMs() float64 {
	c.mu.Lock()
	rep := c.reportRTT
	c.mu.Unlock()
	if rep > 0 {
		return rep
	}
	return c.ep.Snapshot().RTTMs
}

// respawn puts the player back at a spawn point with full health.
func (r *Room) respawn(c *Client) {
	r.spawnSeq++
	c.state = sim.State{Pos: r.m.Spawn(teamNames[c.team], r.spawnSeq), OnGround: true}
	if c.team == 1 {
		c.state.Yaw = sim.AngleFromRadians(math.Pi)
	}
	c.health, c.alive = 100, true
	c.life++
}

// ---- claims (A.5 trust mode, P03 modded client) ----

func (r *Room) processClaims(c *Client, claims []codec.Claim, tick uint32, s Settings) {
	for _, cl := range claims {
		if s.Authority != "trust" {
			c.rejectedClaims++
			r.log.Info("rejected claim", "id", c.id, "name", c.name, "victim", cl.VictimID, "hitbox", cl.Hitbox, "tick", tick)
			r.outbox = append(r.outbox, map[string]any{"t": "claimRejected", "id": c.id, "name": c.name,
				"victimId": cl.VictimID, "hitbox": cl.Hitbox, "tick": tick,
				"reason": "server authority: clients send inputs, not results"})
			continue
		}
		if !c.alive {
			continue
		}
		c.state.Pos = cl.Pos
		c.state.Vel = [3]sim.Fx{}
		v, ok := r.clients[cl.VictimID]
		if cl.VictimID == 0 || !ok || v == c || v.spectator || !v.alive {
			continue
		}
		dmg := uint8(DamageBody)
		if cl.Hitbox == sim.HitHead {
			dmg = DamageHead
		}
		flags := codec.ShotTrustMode
		killed := r.applyDamage(c, v, dmg, cl.Hitbox, cl.InputSeq, tick, float64(tick), flags, sim.Input{Yaw: c.state.Yaw, Pitch: c.state.Pitch})
		sr := codec.ShotResult{ShotSeq: cl.InputSeq, ResolveTick: tick, RewoundTick: tick, Flags: flags, HitID: v.id,
			Hitbox: cl.Hitbox, Damage: dmg, VictimHP: v.health, TickStartMs: r.tickNowMs}
		if killed {
			sr.Flags |= codec.ShotKilled
		}
		c.queueEvent(codec.EvShotResult, sr.Append(nil), r.tickNowMs)
	}
}

// ---- rounds (B.3: team deathmatch, 2-minute rounds) ----

type roundState struct {
	No       int
	State    string // "playing" | "ended"
	EndsAtMs float64
}

func (r *Room) roundMsg() map[string]any {
	return map[string]any{"t": "round", "no": r.round.No, "state": r.round.State, "endsAtServerMs": r.round.EndsAtMs,
		"scores": map[string]int{"blue": r.teamScore[0], "orange": r.teamScore[1]}}
}

func (r *Room) updateRound(now float64) {
	switch {
	case r.round.No == 0:
		r.round = roundState{No: 1, State: "playing", EndsAtMs: now + RoundMs}
		r.outbox = append(r.outbox, r.roundMsg())
	case r.round.State == "playing" && now >= r.round.EndsAtMs:
		r.round.State, r.round.EndsAtMs = "ended", now+IntermissionMs
		r.outbox = append(r.outbox, r.roundMsg())
		r.log.Info("round ended", "no", r.round.No, "blue", r.teamScore[0], "orange", r.teamScore[1])
	case r.round.State == "ended" && now >= r.round.EndsAtMs:
		r.round = roundState{No: r.round.No + 1, State: "playing", EndsAtMs: now + RoundMs}
		r.teamScore = [2]int{}
		for _, c := range r.clients {
			if c.spectator {
				continue
			}
			c.kills, c.deaths = 0, 0
			r.respawn(c)
		}
		r.outbox = append(r.outbox, r.roundMsg())
	}
}

// scorecard (A.2) from the active settings; the client shows it.
func scorecard(s Settings) map[string]bool {
	trust := s.Authority == "trust"
	return map[string]bool{
		"instant":    trust || (s.Predict && s.Reconcile),
		"smooth":     s.Interp,
		"fair":       trust || s.LagComp,
		"cheatProof": !trust,
	}
}

// ---- presenter support (B.7) ----

// historyMsg is the last 2 s of server truth, per tick, for the presenter's
// pause/step view. Positions are Q16.16 like the snapshot.
func (r *Room) historyMsg() map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	rate := int(r.tickRate.Load())
	n := historyKeepMs * rate / 1000
	cur := r.tick.Load()
	type hp struct {
		ID    uint8  `json:"id"`
		Team  string `json:"team"`
		X     int32  `json:"x"`
		Y     int32  `json:"y"`
		Z     int32  `json:"z"`
		Yaw   int16  `json:"yaw"`
		Pitch int16  `json:"pitch"`
		Alive bool   `json:"alive"`
	}
	type ht struct {
		Tick         uint32  `json:"tick"`
		ServerTimeMs float64 `json:"serverTimeMs"`
		Players      []hp    `json:"players"`
	}
	ticks := make([]ht, 0, n)
	for t := cur - uint32(min(int(cur), n-1)); t <= cur && t != 0; t++ {
		e := r.hist.at(t)
		if e == nil {
			continue
		}
		row := ht{Tick: e.tick, ServerTimeMs: e.timeMs}
		for _, p := range e.players {
			row.Players = append(row.Players, hp{p.id, teamNames[p.team], p.pos[0], p.pos[1], p.pos[2], p.yaw, p.pitch, p.alive})
		}
		ticks = append(ticks, row)
	}
	return map[string]any{"t": "history", "tickRate": rate, "ticks": ticks}
}

// relayDebug forwards a client's own view (predicted self, interpolated
// others) to spectators while the truth overlay is on, so the presenter can
// draw the three truths (B.7). It is debug data and never used by the server.
func (r *Room) relayDebug(from *Client, raw []byte) {
	r.mu.Lock()
	on := r.settings.TruthGhost
	var specs []*Client
	for _, c := range r.clients {
		if c.spectator && c != from {
			specs = append(specs, c)
		}
	}
	r.mu.Unlock()
	if !on || len(specs) == 0 || len(raw) > 8192 {
		return
	}
	msg := map[string]any{"t": "debugpos", "from": from.id, "data": json.RawMessage(raw)}
	for _, c := range specs {
		r.send(c, msg)
	}
}

// scoreboardMsg is broadcast at 1 Hz (B.3): kills, deaths, ping, loss, FPS.
func (r *Room) scoreboardMsg() map[string]any {
	type row struct {
		ID       uint8   `json:"id"`
		Name     string  `json:"name"`
		Team     string  `json:"team"`
		Kills    int     `json:"kills"`
		Deaths   int     `json:"deaths"`
		Alive    bool    `json:"alive"`
		PingMs   float64 `json:"pingMs"`
		PingSrc  string  `json:"pingSource"` // "client" (clock sync) or "server-acks"
		LossPct  float64 `json:"lossPct"`
		FPS      float64 `json:"fps"`
		Shots    int     `json:"shots"`
		Hits     int     `json:"hits"`
		Rejected int     `json:"rejectedClaims"`
	}
	r.mu.Lock()
	rows := []row{}
	for _, c := range r.clients {
		if c.spectator {
			continue
		}
		c.mu.Lock()
		rr := row{ID: c.id, Name: c.name, Team: teamNames[c.team], Kills: c.kills, Deaths: c.deaths, Alive: c.alive,
			PingMs: c.reportRTT, PingSrc: "client", LossPct: c.reportLoss, FPS: c.reportFPS, Shots: c.shots, Hits: c.hits,
			Rejected: c.rejectedClaims}
		c.mu.Unlock()
		if rr.PingMs == 0 {
			rr.PingMs, rr.PingSrc = c.ep.Snapshot().RTTMs, "server-acks"
		}
		rows = append(rows, rr)
	}
	msg := r.roundMsg()
	r.mu.Unlock()
	msg["t"] = "scoreboard"
	msg["players"] = rows
	return msg
}
