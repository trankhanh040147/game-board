package main

import (
	"math"
	"slices"
	"time"

	"netcodelab/net/codec"
	"netcodelab/sim"
)

// brain replaces the walker for special bots (B.9 check 3: shooter + runner).
// All methods run with b.mu held.
type brain interface {
	cmd(b *bot, nowMs float64, seq uint32) sim.Cmd // Seq and ClientTick are filled by the caller
	onSnapshot(b *bot, s *codec.Snapshot, nowMs float64)
	report() any
}

// framer is an optional brain hook run every loop pass (~2 ms) to model frames.
type framer interface{ frame(b *bot, nowMs float64) }

// ---- runner: crosses the gap behind and beside the low wall, back and forth ----

type runner struct {
	wp      int
	life    uint8
	started bool
	dead    bool
}

var runnerPath = [][2]float64{{-7, -1.5}, {7, -1.5}}

func (r *runner) onSnapshot(b *bot, s *codec.Snapshot, _ float64) {
	if r.started && s.Own.Life != r.life {
		r.wp = 0 // respawned at an orange spawn: walk back to the gap
	}
	r.life, r.started, r.dead = s.Own.Life, true, s.Own.Dead
}

func (r *runner) cmd(b *bot, _ float64, _ uint32) sim.Cmd {
	p := sim.VecFromFx(b.pred.State.Pos)
	t := runnerPath[r.wp]
	dx, dz := t[0]-p[0], t[1]-p[2]
	if math.Hypot(dx, dz) < 0.5 {
		r.wp = (r.wp + 1) % len(runnerPath)
		if r.wp == 0 {
			r.wp = 1 // after the approach, patrol between the two gap ends
		}
		t = runnerPath[r.wp]
		dx, dz = t[0]-p[0], t[1]-p[2]
	}
	yaw := sim.AngleFromRadians(math.Atan2(-dx, -dz))
	return sim.Cmd{In: sim.Input{Buttons: sim.BtnForward, Yaw: yaw}}
}

func (r *runner) report() any { return nil }

// ---- shooter: stands still, fires at the runner's rendered body centre ----

type snapPos struct {
	tick  uint32
	pos   [3]int32
	alive bool
}

type shotRec struct {
	sawHit     bool
	sawHitbox  uint8
	renderTick float64
}

type shooter struct {
	buf       []snapPos // runner positions by snapshot tick (newest last)
	targetID  uint8
	inputs    int
	pending   map[uint32]shotRec
	resolved  map[uint32]bool
	shots     int // fire inputs sent with a rendered, alive target
	results   int
	agree     int
	sawHits   int
	srvHits   int
	clamped   int
	favoured  int
	disagree  []map[string]any
	movedCm   []float64
	noTarget  int
	unmatched int
}

func newShooter() *shooter {
	return &shooter{pending: map[uint32]shotRec{}, resolved: map[uint32]bool{}}
}

func (s *shooter) onSnapshot(b *bot, snap *codec.Snapshot, _ float64) {
	for _, e := range snap.Entities {
		if e.Team == 1 && (s.targetID == 0 || s.targetID == e.ID) {
			s.targetID = e.ID
			s.buf = append(s.buf, snapPos{tick: snap.ServerTick, pos: e.Pos, alive: e.Anim&codec.AnimDead == 0})
			if len(s.buf) > 64 {
				s.buf = s.buf[len(s.buf)-64:]
			}
		}
	}
	for _, ev := range snap.Events {
		if ev.Type != codec.EvShotResult {
			continue
		}
		var res codec.ShotResult
		r := codec.Reader{B: ev.Data}
		res.Read(&r)
		if r.Err != nil || s.resolved[res.ShotSeq] {
			continue
		}
		s.resolved[res.ShotSeq] = true
		rec, ok := s.pending[res.ShotSeq]
		if !ok {
			s.unmatched++ // a shot fired without a rendered live target: not part of the comparison
			continue
		}
		delete(s.pending, res.ShotSeq)
		s.results++
		srvHit := res.HitID != 0 && res.HitID == s.targetID
		clamped := res.Flags&2 != 0
		if clamped {
			s.clamped++
		}
		if res.Flags&4 != 0 {
			s.favoured++
		}
		if srvHit {
			s.srvHits++
		}
		if rec.sawHit {
			s.sawHits++
		}
		s.movedCm = append(s.movedCm, float64(res.MovedCm))
		if srvHit == rec.sawHit && !clamped {
			s.agree++
		} else if len(s.disagree) < 40 {
			s.disagree = append(s.disagree, map[string]any{"shotSeq": res.ShotSeq, "saw": rec.sawHit, "server": srvHit,
				"serverSeenId": res.SeenID, "flags": res.Flags, "movedCm": res.MovedCm, "renderTick": round2(rec.renderTick),
				"rewound": float64(res.RewoundTick) + float64(res.RewoundFrac)/65536, "resolveTick": res.ResolveTick,
				"at": time.Now().Format("15:04:05.000")})
		}
	}
}

// rendered interpolates the runner at server tick rt from the snapshot buffer.
func (s *shooter) rendered(rt float64) (sim.Vec3, bool) {
	for i := len(s.buf) - 1; i > 0; i-- {
		a, c := s.buf[i-1], s.buf[i]
		if float64(a.tick) <= rt && rt <= float64(c.tick) {
			if !a.alive || !c.alive {
				return sim.Vec3{}, false
			}
			f := (rt - float64(a.tick)) / float64(c.tick-a.tick)
			pa, pc := sim.VecFromFx(a.pos), sim.VecFromFx(c.pos)
			return pa.Add(pc.Sub(pa).Scale(f)), true
		}
	}
	return sim.Vec3{}, false
}

func (s *shooter) cmd(b *bot, nowMs float64, seq uint32) sim.Cmd {
	s.inputs++
	var c sim.Cmd
	c.In.Yaw, c.In.Pitch = b.pred.State.Yaw, b.pred.State.Pitch
	rate := b.set.TickRate
	interp := b.set.InterpMs
	if interp == 0 {
		interp = 100
	}
	rt := b.clk.ServerTick(nowMs) - float64(interp)*float64(rate)/1000
	tp, ok := s.rendered(rt)
	if !ok {
		return c
	}
	eye := sim.EyePos(b.pred.State.Pos)
	aim := tp
	aim[1] += sim.ToFloat(sim.BodyTop) / 2 // body centre
	d := aim.Sub(eye)
	yaw := sim.AngleFromRadians(math.Atan2(-d[0], -d[2]))
	pitch := sim.AngleFromRadians(math.Atan2(d[1], math.Hypot(d[0], d[2])))
	c.In.Yaw, c.In.Pitch = yaw, pitch
	cool := (rate + 9) / 10
	if s.inputs%cool != 0 {
		return c
	}
	dir := sim.AimDir(yaw, pitch)
	dist, part := sim.RayPlayer(eye, dir, tp)
	wall := sim.TraceMap(b.pred.Map, eye, dir, 200)
	saw := part != sim.HitNone && dist < wall
	c.In.Buttons |= sim.BtnFire
	c.RenderTick = uint32(math.Floor(rt))
	c.RenderFrac = uint16((rt - math.Floor(rt)) * 65536)
	s.shots++
	s.pending[seq] = shotRec{sawHit: saw, sawHitbox: part, renderTick: rt}
	return c
}

func (s *shooter) report() any {
	pct := 0.0
	if s.results > 0 {
		pct = 100 * float64(s.agree) / float64(s.results)
	}
	mc := append([]float64(nil), s.movedCm...)
	sortF(mc)
	return map[string]any{"shotsWithRenderedTarget": s.shots, "serverResults": s.results, "agree": s.agree,
		"agreementPct": round2(pct), "shooterSawHit": s.sawHits, "serverHit": s.srvHits, "clamped": s.clamped,
		"favouredVictim": s.favoured, "resultsWithoutRecord": s.unmatched, "unresolved": len(s.pending),
		"movedCm":       map[string]float64{"p50": pct50(mc, 0.5), "p95": pct50(mc, 0.95), "max": pct50(mc, 1)},
		"disagreements": s.disagree}
}

func sortF(v []float64) { slices.Sort(v) }

func pct50(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	return sorted[min(len(sorted)-1, int(float64(len(sorted))*p))]
}
