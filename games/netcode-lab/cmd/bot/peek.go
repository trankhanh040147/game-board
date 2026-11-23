package main

import (
	"math"
	"sync"

	"netcodelab/net/codec"
	"netcodelab/sim"
)

// P14 peek test (research R3 item 2). A holder bot stands still at its spawn; a
// peeker bot hides behind the low wall and moves out past its east edge, again
// and again. Per crossing:
//   t_expose      server time of the tick that processed the peeker's first input
//                 whose authoritative position is visible from the holder;
//   t_peekerSees  first 60 FPS frame of the peeker client showing the holder
//                 unoccluded (own predicted position, holder rendered), server ms;
//   t_holderSees  first 60 FPS frame of the holder client showing the peeker
//                 (interpolated at arrival clock − buffer), server ms.
// Advantage = t_holderSees − t_peekerSees. Both bots run in one process and share
// the crossing number (the server has no crossing id).

const frameMs = 1000.0 / 60

type crossing struct {
	ID           int     `json:"id"`
	ExposeSeq    uint32  `json:"exposeSeq"`
	ExposeMs     float64 `json:"tExposeMs"`
	PeekerSeesMs float64 `json:"tPeekerSeesMs"`
	HolderSeesMs float64 `json:"tHolderSeesMs"`
}

type peekShared struct {
	mu     sync.Mutex
	cross  []*crossing
	want   int
	buffer float64
}

func (p *peekShared) cur() *crossing {
	if len(p.cross) == 0 {
		return nil
	}
	return p.cross[len(p.cross)-1]
}

// visible: line of sight from a's eye to b's eye height, against map boxes.
func visible(m *sim.Map, a, b sim.Vec3) bool {
	eye := a
	eye[1] += sim.ToFloat(sim.EyeHeight)
	t := b
	t[1] += sim.ToFloat(sim.EyeHeight)
	d := t.Sub(eye)
	dist := d.Len()
	if dist < 1e-6 {
		return true
	}
	return sim.TraceMap(m, eye, d.Scale(1/dist), dist) >= dist-1e-6
}

// arrivalRender models the client's interpolation timeline (DECISIONS client 1):
// render server time = local now + max(serverMs − localRecvMs over 2 s) − buffer.
type arrivalRender struct {
	offs  []struct{ at, off float64 }
	buf   []snapPos
	times map[uint32]float64 // serverTick -> serverTimeMs
}

func (a *arrivalRender) add(s *codec.Snapshot, team uint8, nowMs float64) {
	a.offs = append(a.offs, struct{ at, off float64 }{nowMs, s.ServerTimeMs - nowMs})
	for len(a.offs) > 0 && nowMs-a.offs[0].at > 2000 {
		a.offs = a.offs[1:]
	}
	if a.times == nil {
		a.times = map[uint32]float64{}
	}
	a.times[s.ServerTick] = s.ServerTimeMs
	for _, e := range s.Entities {
		if e.Team == team {
			a.buf = append(a.buf, snapPos{tick: s.ServerTick, pos: e.Pos, alive: e.Anim&codec.AnimDead == 0})
		}
	}
	if len(a.buf) > 64 {
		for _, old := range a.buf[:len(a.buf)-64] {
			delete(a.times, old.tick)
		}
		a.buf = a.buf[len(a.buf)-64:]
	}
}

// at returns the interpolated position for local time nowMs.
func (a *arrivalRender) at(nowMs, bufferMs float64) (sim.Vec3, bool) {
	if len(a.offs) == 0 || len(a.buf) < 2 {
		return sim.Vec3{}, false
	}
	maxOff := math.Inf(-1)
	for _, o := range a.offs {
		maxOff = math.Max(maxOff, o.off)
	}
	rs := nowMs + maxOff - bufferMs
	for i := len(a.buf) - 1; i > 0; i-- {
		p, c := a.buf[i-1], a.buf[i]
		tp, tc := a.times[p.tick], a.times[c.tick]
		if tp <= rs && rs <= tc && tc > tp {
			f := (rs - tp) / (tc - tp)
			pp, pc := sim.VecFromFx(p.pos), sim.VecFromFx(c.pos)
			return pp.Add(pc.Sub(pp).Scale(f)), true
		}
	}
	if rs > a.times[a.buf[len(a.buf)-1].tick] {
		return sim.VecFromFx(a.buf[len(a.buf)-1].pos), true // no extrapolation: hold the newest
	}
	return sim.Vec3{}, false
}

// ---- holder ----

type holder struct {
	sh        *peekShared
	peer      arrivalRender
	lastFrame int64
	sawPrev   bool
}

func (h *holder) onSnapshot(b *bot, s *codec.Snapshot, nowMs float64) { h.peer.add(s, 1, nowMs) }

func (h *holder) cmd(b *bot, _ float64, _ uint32) sim.Cmd {
	return sim.Cmd{In: sim.Input{Yaw: b.pred.State.Yaw, Pitch: b.pred.State.Pitch}}
}

func (h *holder) frame(b *bot, nowMs float64) {
	f := int64(nowMs / frameMs)
	if f == h.lastFrame {
		return
	}
	h.lastFrame = f
	ft := float64(f) * frameMs
	pp, ok := h.peer.at(ft, h.sh.buffer)
	if !ok {
		return
	}
	vis := visible(b.pred.Map, sim.VecFromFx(b.pred.State.Pos), pp)
	h.sh.mu.Lock()
	if c := h.sh.cur(); c != nil && vis && !h.sawPrev && c.HolderSeesMs == 0 {
		c.HolderSeesMs = b.clk.ServerTimeMs(ft)
	}
	h.sh.mu.Unlock()
	h.sawPrev = vis
}

func (h *holder) report() any { return nil }

// ---- peeker ----

type peeker struct {
	sh        *peekShared
	holderBuf arrivalRender
	phase     int // 0 approach, 1 hidden wait, 2 out, 3 hold, 4 back
	until     float64
	prevSeq   uint32
	lastFrame int64
	rate      int
}

var (
	peekHide = [2]float64{-1, -2}
	peekOut  = [2]float64{5, -2}
)

func (p *peeker) onSnapshot(b *bot, s *codec.Snapshot, nowMs float64) {
	p.holderBuf.add(s, 0, nowMs)
	p.sh.mu.Lock()
	defer p.sh.mu.Unlock()
	rate := float64(b.set.TickRate)
	for _, c := range p.sh.cross {
		if c.ExposeSeq != 0 && c.ExposeMs == 0 && s.LastProcessedInputSeq >= c.ExposeSeq {
			// One input per tick: the exposing input ran (lastProcessed − seq) ticks before this snapshot's tick.
			ticksBack := float64(s.LastProcessedInputSeq - c.ExposeSeq)
			c.ExposeMs = s.ServerTimeMs - ticksBack*1000/rate
		}
	}
}

func (p *peeker) holderPos() (sim.Vec3, bool) {
	if len(p.holderBuf.buf) == 0 {
		return sim.Vec3{}, false
	}
	return sim.VecFromFx(p.holderBuf.buf[len(p.holderBuf.buf)-1].pos), true // the holder stands still
}

func (p *peeker) cmd(b *bot, nowMs float64, seq uint32) sim.Cmd {
	pos := sim.VecFromFx(b.pred.State.Pos)
	// Exposure check on the state produced by the previous input (prevSeq).
	if hp, ok := p.holderPos(); ok && p.prevSeq != 0 {
		p.sh.mu.Lock()
		if c := p.sh.cur(); c != nil && c.ExposeSeq == 0 && p.phase >= 2 && visible(b.pred.Map, hp, pos) {
			c.ExposeSeq = p.prevSeq
		}
		p.sh.mu.Unlock()
	}
	p.prevSeq = seq
	go2 := func(t [2]float64) (sim.Cmd, bool) {
		dx, dz := t[0]-pos[0], t[1]-pos[2]
		if math.Hypot(dx, dz) < 0.3 {
			return sim.Cmd{In: sim.Input{Yaw: b.pred.State.Yaw}}, true
		}
		return sim.Cmd{In: sim.Input{Buttons: sim.BtnForward, Yaw: sim.AngleFromRadians(math.Atan2(-dx, -dz))}}, false
	}
	switch p.phase {
	case 0:
		c, done := go2(peekHide)
		if done {
			p.phase, p.until = 1, nowMs+2000
		}
		return c
	case 1:
		c, _ := go2(peekHide)
		p.sh.mu.Lock()
		more := len(p.sh.cross) < p.sh.want
		p.sh.mu.Unlock()
		if nowMs >= p.until && more {
			p.sh.mu.Lock()
			p.sh.cross = append(p.sh.cross, &crossing{ID: len(p.sh.cross) + 1})
			p.sh.mu.Unlock()
			p.phase = 2
		}
		return c
	case 2:
		c, done := go2(peekOut)
		if done {
			p.phase, p.until = 3, nowMs+500
		}
		return c
	case 3:
		c, _ := go2(peekOut)
		if nowMs >= p.until {
			p.phase = 4
		}
		return c
	default:
		c, done := go2(peekHide)
		if done {
			p.phase, p.until = 1, nowMs+1500
		}
		return c
	}
}

func (p *peeker) frame(b *bot, nowMs float64) {
	f := int64(nowMs / frameMs)
	if f == p.lastFrame {
		return
	}
	p.lastFrame = f
	hp, ok := p.holderPos()
	if !ok {
		return
	}
	if visible(b.pred.Map, sim.VecFromFx(b.pred.State.Pos), hp) {
		p.sh.mu.Lock()
		if c := p.sh.cur(); c != nil && p.phase >= 2 && c.PeekerSeesMs == 0 {
			c.PeekerSeesMs = b.clk.ServerTimeMs(float64(f) * frameMs)
		}
		p.sh.mu.Unlock()
	}
}

func (p *peeker) report() any { return nil }

func (p *peekShared) report() map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	var adv, pe, he []float64
	complete := []*crossing{}
	for _, c := range p.cross {
		if c.ExposeMs == 0 || c.PeekerSeesMs == 0 || c.HolderSeesMs == 0 {
			continue
		}
		complete = append(complete, c)
		adv = append(adv, c.HolderSeesMs-c.PeekerSeesMs)
		pe = append(pe, c.PeekerSeesMs-c.ExposeMs)
		he = append(he, c.HolderSeesMs-c.ExposeMs)
	}
	ms := func(v []float64) map[string]float64 {
		if len(v) == 0 {
			return nil
		}
		m, sd := meanSD(v)
		s := append([]float64(nil), v...)
		sortF(s)
		return map[string]float64{"mean": round2(m), "sd": round2(sd), "min": round2(s[0]), "max": round2(s[len(s)-1])}
	}
	return map[string]any{"label": "our measurement", "crossingsStarted": len(p.cross), "crossingsComplete": len(complete),
		"advantageMs": ms(adv), "peekerSeesMinusExposeMs": ms(pe), "holderSeesMinusExposeMs": ms(he),
		"bufferMs": p.buffer, "frameMs": round2(frameMs), "crossings": complete}
}

func meanSD(v []float64) (float64, float64) {
	m := 0.0
	for _, x := range v {
		m += x
	}
	m /= float64(len(v))
	s := 0.0
	for _, x := range v {
		s += (x - m) * (x - m)
	}
	if len(v) > 1 {
		s /= float64(len(v) - 1)
	}
	return m, math.Sqrt(s)
}
