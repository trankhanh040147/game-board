package main

import (
	"context"
	"encoding/json"
	"math"
	"math/rand/v2"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"netcodelab/net/codec"
	"netcodelab/sim"
)

// filler is a fill bot (B.1 goal 1, B.2 "Fill teams"): it roams the Courtyard,
// crosses the gap, holds corners, and shoots visible enemies after a human-ish
// reaction delay with aim error. It is beatable on purpose. It fires only
// through normal inputs (with the render time it saw, like a client); the
// server decides every hit. It never sends claims.
type filler struct {
	rng      *rand.Rand
	ents     map[uint8]*fillEnt
	wp       sim.Vec3
	hasWP    bool
	holdTill float64 // ms: stand at a corner until then
	stuckAt  float64
	lastPos  sim.Vec3
	life     uint8
	dead     bool
	started  bool
	team     uint8 // 0 blue, 1 orange (from welcome)

	target   uint8
	seenAt   float64 // when the current target became visible (ms)
	react    float64 // reaction delay for this acquisition (ms)
	errYaw   float64 // aim error (radians), redrawn every few hundred ms
	errPitch float64
	errAt    float64
	yaw      float64
	pitch    float64
	inputs   int

	shots, hits, kills, deaths, acquisitions int
	resolved                                 map[uint32]bool
}

type fillEnt struct {
	team  uint8
	buf   []snapPos
	alive bool
}

// Courtyard points (x, z): lanes, gap ends, block corners, behind the low wall, crates.
var fillPoints = [][2]float64{
	{-17, 20}, {17, 20}, {-17, -20}, {17, -20}, // side lanes
	{-17, 0}, {17, 0}, // lane middles
	{-6, 1.5}, {6, 1.5}, {-6, -1.5}, {6, -1.5}, // gap ends, either side of the low wall
	{0, 2}, {0, -2}, // behind the low wall
	{-7, 13}, {7, 13}, {-7, -13}, {7, -13}, // block corners (peeks)
	{-4.5, 20}, {4.5, -20}, // crates
}

func newFiller(seed uint64) *filler {
	return &filler{rng: rand.New(rand.NewPCG(seed, seed^0xF111)), ents: map[uint8]*fillEnt{}, resolved: map[uint32]bool{}}
}

func (f *filler) onSnapshot(b *bot, s *codec.Snapshot, _ float64) {
	f.team = b.team
	seen := map[uint8]bool{}
	for _, e := range s.Entities {
		en := f.ents[e.ID]
		if en == nil {
			en = &fillEnt{}
			f.ents[e.ID] = en
		}
		en.team, en.alive = e.Team, e.Anim&codec.AnimDead == 0
		en.buf = append(en.buf, snapPos{tick: s.ServerTick, pos: e.Pos, alive: en.alive})
		if len(en.buf) > 32 {
			en.buf = en.buf[len(en.buf)-32:]
		}
		seen[e.ID] = true
	}
	for id := range f.ents {
		if !seen[id] {
			delete(f.ents, id)
		}
	}
	if f.started && s.Own.Life != f.life {
		f.hasWP, f.target = false, 0 // respawned: new plan
	}
	if s.Own.Dead && !f.dead {
		f.deaths++
	}
	f.life, f.dead, f.started = s.Own.Life, s.Own.Dead, true
	for _, ev := range s.Events {
		if ev.Type != codec.EvShotResult {
			continue
		}
		var res codec.ShotResult
		r := codec.Reader{B: ev.Data}
		res.Read(&r)
		if r.Err != nil || f.resolved[res.ShotSeq] {
			continue
		}
		f.resolved[res.ShotSeq] = true
		if res.HitID != 0 {
			f.hits++
		}
		if res.Flags&codec.ShotKilled != 0 {
			f.kills++
		}
	}
}

// rendered: where this client draws entity e at server tick rt (interpolated), like the browser.
func (en *fillEnt) rendered(rt float64) (sim.Vec3, bool) {
	for i := len(en.buf) - 1; i > 0; i-- {
		a, c := en.buf[i-1], en.buf[i]
		if float64(a.tick) <= rt && rt <= float64(c.tick) {
			if !a.alive || !c.alive {
				return sim.Vec3{}, false
			}
			t := (rt - float64(a.tick)) / float64(c.tick-a.tick)
			pa, pc := sim.VecFromFx(a.pos), sim.VecFromFx(c.pos)
			return pa.Add(pc.Sub(pa).Scale(t)), true
		}
	}
	return sim.Vec3{}, false
}

func angDiff(a, b float64) float64 {
	d := math.Mod(a-b+3*math.Pi, 2*math.Pi) - math.Pi
	return d
}

func (f *filler) cmd(b *bot, nowMs float64, _ uint32) sim.Cmd {
	f.inputs++
	var c sim.Cmd
	st := b.pred.State
	if f.inputs == 1 {
		f.yaw = sim.AngleToRadians(st.Yaw)
	}
	if f.dead {
		c.In.Yaw, c.In.Pitch = sim.AngleFromRadians(f.yaw), sim.AngleFromRadians(f.pitch)
		return c
	}
	rate := b.set.TickRate
	if rate == 0 {
		rate = 64
	}
	interp := b.set.InterpMs
	if interp == 0 {
		interp = 100
	}
	rt := b.clk.ServerTick(nowMs) - float64(interp)*float64(rate)/1000
	eye := sim.EyePos(st.Pos)
	pos := sim.VecFromFx(st.Pos)
	dt := 1.0 / float64(rate)

	// Pick the nearest visible living enemy, as drawn at render time.
	var best uint8
	var bestPos sim.Vec3
	bestD := 45.0
	for id, en := range f.ents {
		if en.team == f.team || !en.alive {
			continue
		}
		p, ok := en.rendered(rt)
		if !ok {
			continue
		}
		aim := p
		aim[1] += sim.ToFloat(sim.BodyTop) / 2
		d := aim.Sub(eye)
		dist := d.Len()
		if dist > bestD || dist < 0.1 {
			continue
		}
		dir := d.Scale(1 / dist)
		if sim.TraceMap(b.pred.Map, eye, dir, dist) < dist-0.3 {
			continue // behind cover
		}
		best, bestPos, bestD = id, aim, dist
	}
	if best != f.target {
		f.target = best
		if best != 0 {
			f.seenAt = nowMs
			f.react = 250 + f.rng.Float64()*250 // 250–500 ms to react (human-ish)
			f.acquisitions++
		}
	}
	if nowMs-f.errAt > 300 {
		f.errAt = nowMs
		f.errYaw = f.rng.NormFloat64() * 0.035 // ≈ 2° sd: misses at range, hits up close
		f.errPitch = f.rng.NormFloat64() * 0.025
	}

	turn := 4.0 * dt // max 4 rad/s turn (no snap aim)
	if f.target != 0 {
		d := bestPos.Sub(eye)
		wantYaw := math.Atan2(-d[0], -d[2]) + f.errYaw
		wantPitch := math.Atan2(d[1], math.Hypot(d[0], d[2])) + f.errPitch
		dy := angDiff(wantYaw, f.yaw)
		f.yaw += math.Max(-turn, math.Min(turn, dy))
		f.pitch += math.Max(-turn, math.Min(turn, wantPitch-f.pitch))
		c.In.Yaw, c.In.Pitch = sim.AngleFromRadians(f.yaw), sim.AngleFromRadians(f.pitch)
		// Strafe a little while fighting.
		if (int(nowMs)/700)%2 == 0 {
			c.In.Buttons |= sim.BtnLeft
		} else {
			c.In.Buttons |= sim.BtnRight
		}
		cool := (rate + 9) / 10
		if nowMs-f.seenAt >= f.react && math.Abs(dy) < 0.08 && f.inputs%cool == 0 {
			c.In.Buttons |= sim.BtnFire
			c.RenderTick = uint32(math.Floor(rt))
			c.RenderFrac = uint16((rt - math.Floor(rt)) * 65536)
			f.shots++
		}
		return c
	}

	// No target: hold a corner for a while, or walk to the next point.
	if nowMs < f.holdTill {
		// Look toward the enemy half while holding.
		want := 0.0 // yaw 0 faces -Z (toward orange)
		if f.team == 1 {
			want = math.Pi
		}
		f.yaw += math.Max(-turn, math.Min(turn, angDiff(want, f.yaw)))
		c.In.Yaw = sim.AngleFromRadians(f.yaw)
		return c
	}
	if !f.hasWP || math.Hypot(f.wp[0]-pos[0], f.wp[2]-pos[2]) < 1.2 {
		if f.hasWP && f.rng.IntN(3) == 0 {
			f.holdTill = nowMs + 1500 + f.rng.Float64()*2500
		}
		p := fillPoints[f.rng.IntN(len(fillPoints))]
		f.wp, f.hasWP, f.stuckAt, f.lastPos = sim.Vec3{p[0], 0, p[1]}, true, nowMs, pos
	}
	if nowMs-f.stuckAt > 1500 { // little progress in 1.5 s: blocked, pick another point
		if math.Hypot(pos[0]-f.lastPos[0], pos[2]-f.lastPos[2]) < 1 {
			f.hasWP = false
		}
		f.stuckAt, f.lastPos = nowMs, pos
	}
	d := f.wp.Sub(pos)
	want := math.Atan2(-d[0], -d[2])
	f.yaw += math.Max(-turn*1.5, math.Min(turn*1.5, angDiff(want, f.yaw)))
	f.pitch *= 0.9
	c.In.Yaw, c.In.Pitch = sim.AngleFromRadians(f.yaw), sim.AngleFromRadians(f.pitch)
	c.In.Buttons |= sim.BtnForward
	if f.rng.IntN(400) == 0 {
		c.In.Buttons |= sim.BtnJump
	}
	return c
}

func (f *filler) report() any {
	return map[string]any{"shots": f.shots, "serverHits": f.hits, "kills": f.kills, "deaths": f.deaths, "acquisitions": f.acquisitions}
}

var fillNames = []string{"Ava", "Bao", "Chi", "Dung", "Em", "Giang", "Hai", "Khanh", "Lan", "Minh", "Nam", "Oanh"}

// runFill runs n fill bots until ctx ends or the process gets SIGINT/SIGTERM
// (the server stops its fill process that way), then prints one JSON summary.
// Names end in " [bot]" so the scoreboard and kill feed show what they are.
func runFill(ctx context.Context, url string, n int) {
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	var wg sync.WaitGroup
	out := make([]Summary, n)
	base := uint64(time.Now().UnixNano())
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			name := fillNames[i%len(fillNames)] + " [bot]"
			out[i] = run(ctx, url, name, base+uint64(i)*7919, nil, newFiller(base+uint64(i)))
		}()
		time.Sleep(150 * time.Millisecond)
	}
	wg.Wait()
	enc := json.NewEncoder(os.Stdout)
	enc.Encode(map[string]any{"kind": "fill", "bots": n, "perBot": out})
}
