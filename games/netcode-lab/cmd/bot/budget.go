package main

import (
	"math"
	"math/rand/v2"
	"sync"

	"netcodelab/net/codec"
)

// budget measures A.11 / P11 / B.9 check 4: one shot from the shooter's click until
// the target sees it, split into the A.11 segments, all in server ms:
//
//	shooterFrame  click -> the shooter's next frame (click uniform within a frame)
//	sendWait      that frame -> the pacer sends the fire input (not in the A.11 table)
//	uplink        send -> server receive (ShotResult.recvMs, after the uplink conditioner)
//	playoutBuffer receive -> start of the tick that resolved it (the input waits for its stamped tick, DECISIONS 51)
//	snapshotWait  tick start -> send of the target's first snapshot carrying the Damage event
//	downlink      that send -> target receive
//	interp        receive -> render time reaches the shot (arrival clock + buffer, client model)
//	targetFrame   -> the target's next frame
//
// Frames are modelled at fps (no renderer): a headless bot has no display.
type budget struct {
	mu      sync.Mutex
	frameMs float64
	bufMs   float64
	rng     *rand.Rand
	shots   map[uint32]*shotBudget
}

type shotBudget struct {
	clickSrv, frameSrv, sendSrv float64 // shooter side, server ms
	recvMs, tickStartMs         float64 // server stamps
	snapSendMs, targetRecvSrv   float64 // target side
	tgtNowLocal, tgtMaxOff      float64
	tgtOff                      float64 // target clock: server ms − local ms at arrival
	haveShooter, haveServer     bool
	haveTarget                  bool
}

func newBudget(fps, bufMs float64) *budget {
	return &budget{frameMs: 1000 / fps, bufMs: bufMs, rng: rand.New(rand.NewPCG(7, 11)), shots: map[uint32]*shotBudget{}}
}

func (bu *budget) get(seq uint32) *shotBudget {
	s := bu.shots[seq]
	if s == nil {
		s = &shotBudget{}
		bu.shots[seq] = s
	}
	return s
}

// onFire: called by the shooter when it sends a fire input at local time nowMs.
func (bu *budget) onFire(b *bot, seq uint32, nowMs float64) {
	bu.mu.Lock()
	defer bu.mu.Unlock()
	f := math.Floor(nowMs/bu.frameMs) * bu.frameMs // the frame that sampled the click
	c := f - bu.rng.Float64()*bu.frameMs           // the click, uniform within the frame before it
	s := bu.get(seq)
	s.clickSrv, s.frameSrv, s.sendSrv = b.clk.ServerTimeMs(c), b.clk.ServerTimeMs(f), b.clk.ServerTimeMs(nowMs)
	s.haveShooter = true
}

func (bu *budget) onResult(r *codec.ShotResult) {
	bu.mu.Lock()
	defer bu.mu.Unlock()
	s := bu.get(r.ShotSeq)
	s.recvMs, s.tickStartMs, s.haveServer = r.RecvMs, r.TickStartMs, true
}

// onDamage: the target received its first snapshot carrying the Damage event for seq.
func (bu *budget) onDamage(b *bot, seq uint32, snapServerMs, nowMs, maxOff float64) {
	bu.mu.Lock()
	defer bu.mu.Unlock()
	s := bu.get(seq)
	if s.haveTarget {
		return
	}
	s.snapSendMs, s.targetRecvSrv = snapServerMs, b.clk.ServerTimeMs(nowMs)
	s.tgtNowLocal, s.tgtMaxOff, s.tgtOff = nowMs, maxOff, b.clk.ServerTimeMs(nowMs)-nowMs
	s.haveTarget = true
}

func (bu *budget) report() map[string]any {
	bu.mu.Lock()
	defer bu.mu.Unlock()
	names := []string{"shooterFrame", "sendWait", "uplink", "playoutBuffer", "snapshotWait", "downlink", "interp", "targetFrame", "total"}
	seg := map[string][]float64{}
	n := 0
	for _, s := range bu.shots {
		if !(s.haveShooter && s.haveServer && s.haveTarget) {
			continue
		}
		n++
		// Shown when the target's render server time (local + maxOff − buffer) reaches the
		// shot's tick start, never before arrival; then the next frame.
		showLocal := math.Max(s.tgtNowLocal, s.tickStartMs-s.tgtMaxOff+bu.bufMs)
		frameLocal := math.Ceil(showLocal/bu.frameMs) * bu.frameMs
		showSrv, targetFrameSrv := showLocal+s.tgtOff, frameLocal+s.tgtOff
		v := []float64{s.frameSrv - s.clickSrv, s.sendSrv - s.frameSrv, s.recvMs - s.sendSrv, s.tickStartMs - s.recvMs,
			s.snapSendMs - s.tickStartMs, s.targetRecvSrv - s.snapSendMs, showSrv - s.targetRecvSrv, targetFrameSrv - showSrv,
			targetFrameSrv - s.clickSrv}
		for i, k := range names {
			seg[k] = append(seg[k], v[i])
		}
	}
	out := map[string]any{"shotsMeasured": n, "frameMs": round2(bu.frameMs), "bufferMs": round2(bu.bufMs),
		"note": "server ms; frames modelled (no display); click uniform within a frame"}
	for _, k := range names {
		if len(seg[k]) == 0 {
			continue
		}
		m, sd := meanSD(seg[k])
		v := append([]float64(nil), seg[k]...)
		sortF(v)
		out[k] = map[string]float64{"mean": round2(m), "sd": round2(sd), "p50": round2(pct50(v, 0.5)), "p95": round2(pct50(v, 0.95))}
	}
	return out
}
