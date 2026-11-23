//go:build js && wasm

// Command wasm exposes the shared sim, the wire codec, clock sync and the
// input pacer to the browser as globalThis.NetcodeSim. The JS API is
// documented in docs/ARCHITECTURE.md.
package main

import (
	"fmt"
	"syscall/js"

	"netcodelab/net/clock"
	"netcodelab/net/codec"
	"netcodelab/shared"
	"netcodelab/sim"
)

var (
	world   = sim.Courtyard()
	handles = map[int]any{}
	nextH   = 1
)

func put(v any) int { h := nextH; nextH++; handles[h] = v; return h }

func get[T any](v js.Value) T {
	x, ok := handles[v.Int()].(T)
	if !ok {
		panic(fmt.Sprintf("NetcodeSim: bad handle %d", v.Int()))
	}
	return x
}

func stateFromJS(v js.Value) sim.State {
	return sim.State{
		Pos:      [3]sim.Fx{int32(v.Get("x").Int()), int32(v.Get("y").Int()), int32(v.Get("z").Int())},
		Vel:      [3]sim.Fx{int32(v.Get("vx").Int()), int32(v.Get("vy").Int()), int32(v.Get("vz").Int())},
		OnGround: v.Get("onGround").Truthy(),
		Yaw:      int16(v.Get("yaw").Int()),
		Pitch:    int16(v.Get("pitch").Int()),
	}
}

func stateToJS(s sim.State) js.Value {
	return js.ValueOf(map[string]any{
		"x": int(s.Pos[0]), "y": int(s.Pos[1]), "z": int(s.Pos[2]),
		"vx": int(s.Vel[0]), "vy": int(s.Vel[1]), "vz": int(s.Vel[2]),
		"onGround": s.OnGround, "yaw": int(s.Yaw), "pitch": int(s.Pitch),
	})
}

func optInt(v js.Value, k string) int {
	x := v.Get(k)
	if x.IsUndefined() || x.IsNull() {
		return 0
	}
	return x.Int()
}

func inputFromJS(v js.Value) sim.Input {
	return sim.Input{Buttons: uint16(optInt(v, "buttons")), Yaw: int16(optInt(v, "yaw")), Pitch: int16(optInt(v, "pitch"))}
}

func cmdFromJS(v js.Value) sim.Cmd {
	return sim.Cmd{
		Seq: uint32(optInt(v, "seq")), ClientTick: uint32(optInt(v, "clientTick")), In: inputFromJS(v),
		RenderTick: uint32(optInt(v, "renderTick")), RenderFrac: uint16(optInt(v, "renderFrac")), SubtickFrac: uint16(optInt(v, "subtickFrac")),
	}
}

func cmdToJS(c sim.Cmd) any {
	return map[string]any{"seq": int(c.Seq), "clientTick": int(c.ClientTick), "buttons": int(c.In.Buttons),
		"yaw": int(c.In.Yaw), "pitch": int(c.In.Pitch), "renderTick": int(c.RenderTick),
		"renderFrac": int(c.RenderFrac), "subtickFrac": int(c.SubtickFrac)}
}

func bytesToJS(b []byte) js.Value {
	u := js.Global().Get("Uint8Array").New(len(b))
	js.CopyBytesToJS(u, b)
	return u
}

func bytesFromJS(v js.Value) []byte {
	b := make([]byte, v.Get("length").Int())
	js.CopyBytesToGo(b, v)
	return b
}

func fn(f func(args []js.Value) any) js.Func {
	return js.FuncOf(func(this js.Value, args []js.Value) any { return f(args) })
}

func m(meters sim.Fx) float64 { return sim.ToFloat(meters) }

func decode(ep *codec.Endpoint, store *codec.Baselines, b []byte, now float64) any {
	r := codec.Reader{B: b}
	h := r.Header()
	if r.Err != nil {
		return map[string]any{"type": "invalid", "error": r.Err.Error()}
	}
	dup, _ := ep.OnReceive(h, now)
	out := map[string]any{"dup": dup, "seq": int(h.Seq), "ack": int(h.Ack), "ackBits": float64(h.AckBits)}
	switch h.Type {
	case codec.TSnapshot:
		var s codec.Snapshot
		codec.ReadSnapshotWith(&r, &s, store)
		ents := make([]any, len(s.Entities))
		for i, e := range s.Entities {
			ents[i] = map[string]any{"id": int(e.ID), "team": int(e.Team), "x": int(e.Pos[0]), "y": int(e.Pos[1]), "z": int(e.Pos[2]),
				"yaw": int(e.Yaw), "pitch": int(e.Pitch), "health": int(e.Health), "anim": int(e.Anim)}
		}
		evs := make([]any, len(s.Events))
		for i, e := range s.Events {
			evs[i] = decodeEvent(e)
		}
		out["type"] = "snapshot"
		out["serverTick"] = int(s.ServerTick)
		out["serverTimeMs"] = s.ServerTimeMs
		out["lastProcessedInputSeq"] = int(s.LastProcessedInputSeq)
		out["own"] = map[string]any{"state": stateToJS(s.Own.State), "health": int(s.Own.Health), "inputBuffer": int(s.Own.InputBuffer),
			"starved": int(s.Own.Starved), "inputLead": int(s.Own.InputLead),
			"dead": s.Own.Dead, "life": int(s.Own.Life)}
		out["baselineId"] = int(s.BaselineID)
		out["snapId"] = int(s.SnapID)
		out["encoding"] = int(s.Encoding)
		out["entities"] = ents
		out["events"] = evs
	case codec.TPong:
		var p codec.Pong
		codec.ReadPong(&r, &p)
		out["type"] = "pong"
		out["clientSendMs"], out["serverRecvMs"], out["serverSendMs"] = p.ClientSendMs, p.ServerRecvMs, p.ServerSendMs
		out["serverTick"], out["tickFrac"], out["tickRate"] = int(p.ServerTick), int(p.TickFrac), int(p.TickRate)
	case codec.TDebug:
		var d codec.Debug
		codec.ReadDebug(&r, &d)
		ps := make([]any, len(d.Players))
		for i, p := range d.Players {
			ps[i] = map[string]any{"id": int(p.ID), "x": int(p.Pos[0]), "y": int(p.Pos[1]), "z": int(p.Pos[2])}
		}
		out["type"] = "debug"
		out["serverTick"] = int(d.ServerTick)
		out["players"] = ps
	default:
		out["type"] = "unknown"
		out["code"] = int(h.Type)
	}
	if r.Err != nil {
		return map[string]any{"type": "invalid", "error": r.Err.Error()}
	}
	return out
}

// wconn is one connection's codec state: ack header + delta baselines.
type wconn struct {
	ep   codec.Endpoint
	base codec.Baselines
}

func pos3(p [3]int32) any { return []any{int(p[0]), int(p[1]), int(p[2])} }

func decodeEvent(e codec.Event) any {
	r := codec.Reader{B: e.Data}
	switch e.Type {
	case codec.EvShotResult:
		var v codec.ShotResult
		v.Read(&r)
		if r.Err == nil {
			return map[string]any{"type": "shot", "shotSeq": int(v.ShotSeq), "resolveTick": int(v.ResolveTick),
				"renderTick": int(v.RenderTick), "renderFrac": int(v.RenderFrac), "rewoundTick": int(v.RewoundTick), "rewoundFrac": int(v.RewoundFrac),
				"flags": int(v.Flags), "lagcomp": v.Flags&codec.ShotLagComp != 0, "clamped": v.Flags&codec.ShotClamped != 0,
				"favoured": v.Flags&codec.ShotFavoured != 0, "killed": v.Flags&codec.ShotKilled != 0, "trust": v.Flags&codec.ShotTrustMode != 0,
				"hitId": int(v.HitID), "hitbox": int(v.Hitbox), "damage": int(v.Damage), "victimHp": int(v.VictimHP),
				"seenId": int(v.SeenID), "seenHitbox": int(v.SeenHitbox), "movedCm": int(v.MovedCm),
				"seenPos": pos3(v.SeenPos), "usedPos": pos3(v.UsedPos), "wallDistM": float64(v.WallDistCm) / 100,
				"recvMs": v.RecvMs, "tickStartMs": v.TickStartMs,
				"subtickFrac": int(v.SubtickFrac), "timingErrMs": float64(v.TimingErrUs) / 1000}
		}
	case codec.EvDamage:
		var v codec.Damage
		v.Read(&r)
		if r.Err == nil {
			return map[string]any{"type": "damage", "shotSeq": int(v.ShotSeq), "shooterId": int(v.ShooterID), "hitbox": int(v.Hitbox),
				"damage": int(v.Damage), "health": int(v.Health), "resolveTick": int(v.ResolveTick), "flags": int(v.Flags),
				"killed": v.Flags&codec.ShotKilled != 0}
		}
	case codec.EvDeath:
		var v codec.Death
		v.Read(&r)
		if r.Err == nil {
			return map[string]any{"type": "death", "life": int(v.Life), "shooterId": int(v.ShooterID), "hitbox": int(v.Hitbox),
				"flags": int(v.Flags), "lagcomp": v.Flags&codec.ShotLagComp != 0, "shotSeq": int(v.ShotSeq), "resolveTick": int(v.ResolveTick),
				"rewoundTick": int(v.RewoundTick), "rewoundFrac": int(v.RewoundFrac), "hitPos": pos3(v.HitPos), "nowPos": pos3(v.NowPos),
				"shooterPos": pos3(v.ShooterPos), "shooterYaw": int(v.ShooterYaw), "shooterPitch": int(v.ShooterPitch), "respawnTick": int(v.RespawnTick)}
		}
	}
	return map[string]any{"type": "unknown", "code": int(e.Type), "data": bytesToJS(e.Data)}
}

func pongFromJS(v js.Value) codec.Pong {
	return codec.Pong{
		ClientSendMs: v.Get("clientSendMs").Float(), ServerRecvMs: v.Get("serverRecvMs").Float(), ServerSendMs: v.Get("serverSendMs").Float(),
		ServerTick: uint32(v.Get("serverTick").Int()), TickFrac: uint16(v.Get("tickFrac").Int()), TickRate: uint16(v.Get("tickRate").Int()),
	}
}

func main() {
	api := map[string]any{
		"apiVersion":      3,
		"protocolVersion": 3,
		"FX":              int(sim.One),
		"BTN": map[string]any{"forward": int(sim.BtnForward), "back": int(sim.BtnBack), "left": int(sim.BtnLeft),
			"right": int(sim.BtnRight), "jump": int(sim.BtnJump), "fire": int(sim.BtnFire)},
		"ENC":  map[string]any{"quant": int(codec.EncQuant), "bitpack": int(codec.EncBitpack), "delta": int(codec.EncDelta)},
		"HIT":  map[string]any{"none": int(sim.HitNone), "body": int(sim.HitBody), "head": int(sim.HitHead)},
		"ANIM": map[string]any{"onGround": int(codec.AnimOnGround), "moving": int(codec.AnimMoving), "dead": int(codec.AnimDead)},
		"PLAYER": map[string]any{"halfWidth": m(sim.HalfWidth), "height": m(sim.Height), "eyeHeight": m(sim.EyeHeight),
			"body": map[string]any{"half": m(sim.BodyHalf), "top": m(sim.BodyTop)},
			"head": map[string]any{"half": m(sim.HeadHalf), "bottom": m(sim.HeadBottom), "top": m(sim.HeadTop)}},
		"mapJSON": string(shared.MapJSON),

		"dtForRate":        fn(func(a []js.Value) any { return int(sim.DtForRate(a[0].Int())) }),
		"angleFromRadians": fn(func(a []js.Value) any { return int(sim.AngleFromRadians(a[0].Float())) }),
		"angleToRadians":   fn(func(a []js.Value) any { return sim.AngleToRadians(int16(a[0].Int())) }),
		"step": fn(func(a []js.Value) any {
			s := stateFromJS(a[0])
			p := sim.DefaultParams()
			sim.Step(world, &s, inputFromJS(a[1]), sim.Fx(a[2].Int()), &p)
			return stateToJS(s)
		}),
		"hash": fn(func(a []js.Value) any { return fmt.Sprintf("%016x", stateFromJS(a[0]).Hash()) }),

		"newPredictor": fn(func(a []js.Value) any { return put(sim.NewPredictor(world, stateFromJS(a[0]))) }),
		"predictorReset": fn(func(a []js.Value) any {
			get[*sim.Predictor](a[0]).Reset(stateFromJS(a[1]))
			return nil
		}),
		"predict": fn(func(a []js.Value) any {
			return stateToJS(get[*sim.Predictor](a[0]).Predict(cmdFromJS(a[1]), sim.Fx(a[2].Int())))
		}),
		"reconcile": fn(func(a []js.Value) any {
			p := get[*sim.Predictor](a[0])
			var r sim.ReconcileResult
			if len(a) >= 7 {
				r = p.ReconcileLife(stateFromJS(a[1]), uint32(a[2].Int()), sim.Fx(a[3].Int()), a[4].Truthy(), uint8(a[5].Int()), a[6].Truthy())
			} else {
				r = p.Reconcile(stateFromJS(a[1]), uint32(a[2].Int()), sim.Fx(a[3].Int()), a[4].Truthy())
			}
			return map[string]any{"state": stateToJS(p.State), "corrected": r.Corrected, "replayed": r.Replayed, "respawned": r.Respawned,
				"delta": []any{int(r.Delta[0]), int(r.Delta[1]), int(r.Delta[2])}}
		}),
		"predictorInfo": fn(func(a []js.Value) any {
			p := get[*sim.Predictor](a[0])
			pend := p.Pending()
			seqs := make([]any, len(pend))
			for i, c := range pend {
				seqs[i] = int(c.Seq)
			}
			return map[string]any{"state": stateToJS(p.State), "corrections": float64(p.Corrections), "replayed": float64(p.Replayed), "pending": seqs}
		}),

		"newConn": fn(func(a []js.Value) any { return put(&wconn{}) }),
		"encodeInput": fn(func(a []js.Value) any {
			ep := &get[*wconn](a[0]).ep
			arr := a[1]
			cmds := make([]sim.Cmd, arr.Length())
			for i := range cmds {
				cmds[i] = cmdFromJS(arr.Index(i))
			}
			var w codec.Writer
			codec.AppendInput(&w, ep.NextHeader(codec.TInput, a[2].Float()), &codec.Input{Cmds: cmds})
			return bytesToJS(w.B)
		}),
		"encodeInputFromPredictor": fn(func(a []js.Value) any {
			ep := &get[*wconn](a[0]).ep
			pend := get[*sim.Predictor](a[1]).Pending()
			var w codec.Writer
			codec.AppendInput(&w, ep.NextHeader(codec.TInput, a[2].Float()), &codec.Input{Cmds: pend[max(0, len(pend)-codec.MaxCmds):]})
			return bytesToJS(w.B)
		}),
		"pendingCmds": fn(func(a []js.Value) any {
			pend := get[*sim.Predictor](a[0]).Pending()
			out := make([]any, len(pend))
			for i, c := range pend {
				out[i] = cmdToJS(c)
			}
			return out
		}),
		"encodePing": fn(func(a []js.Value) any {
			ep := &get[*wconn](a[0]).ep
			now := a[1].Float()
			var w codec.Writer
			codec.AppendPing(&w, ep.NextHeader(codec.TPing, now), &codec.Ping{ClientSendMs: now})
			return bytesToJS(w.B)
		}),
		"encodeSnapshotAck": fn(func(a []js.Value) any {
			ep := &get[*wconn](a[0]).ep
			var w codec.Writer
			codec.AppendSnapshotAck(&w, ep.NextHeader(codec.TSnapshotAck, a[3].Float()),
				&codec.SnapshotAck{BaselineID: uint8(a[1].Int()), ServerTick: uint32(a[2].Int())})
			return bytesToJS(w.B)
		}),
		"decode": fn(func(a []js.Value) any {
			wc := get[*wconn](a[0])
			return decode(&wc.ep, &wc.base, bytesFromJS(a[1]), a[2].Float())
		}),
		"connStats": fn(func(a []js.Value) any {
			s := get[*wconn](a[0]).ep.Snapshot()
			return map[string]any{"sent": float64(s.Sent), "acked": float64(s.Acked), "lost": float64(s.Lost), "rttMs": s.RTTMs,
				"received": float64(s.Received), "duplicates": float64(s.Duplicates), "old": float64(s.Old), "remoteGaps": float64(s.RemoteGaps)}
		}),

		"encodeClaim": fn(func(a []js.Value) any {
			ep := &get[*wconn](a[0]).ep
			v := a[1]
			c := codec.Claim{InputSeq: uint32(optInt(v, "seq")), ClientTick: uint32(optInt(v, "clientTick")),
				Pos:      [3]int32{int32(optInt(v, "x")), int32(optInt(v, "y")), int32(optInt(v, "z"))},
				VictimID: uint8(optInt(v, "victimId")), Hitbox: uint8(optInt(v, "hitbox"))}
			var w codec.Writer
			codec.AppendClaim(&w, ep.NextHeader(codec.TClaim, a[2].Float()), &c)
			return bytesToJS(w.B)
		}),
		"aimDir": fn(func(a []js.Value) any {
			d := sim.AimDir(int16(a[0].Int()), int16(a[1].Int()))
			return []any{d[0], d[1], d[2]}
		}),
		"traceMap": fn(func(a []js.Value) any {
			o := sim.EyePos([3]sim.Fx{int32(a[0].Int()), int32(a[1].Int()), int32(a[2].Int())})
			return sim.TraceMap(world, o, sim.AimDir(int16(a[3].Int()), int16(a[4].Int())), 300)
		}),
		"fireCooldownTicks": fn(func(a []js.Value) any { return (a[0].Int() + 9) / 10 }),
		"newClock":          fn(func(a []js.Value) any { return put(&clock.Sync{}) }),
		"clockPong": fn(func(a []js.Value) any {
			get[*clock.Sync](a[0]).OnPong(pongFromJS(a[1]), a[2].Float())
			return nil
		}),
		"clockEstimate": fn(func(a []js.Value) any {
			c := get[*clock.Sync](a[0])
			now := a[1].Float()
			e := c.Estimate()
			return map[string]any{"ready": c.Ready(), "offsetMs": e.OffsetMs, "rttMs": e.RTTMs, "minRttMs": e.MinRTTMs,
				"lastRttMs": e.LastRTTMs, "jitterMs": e.JitterMs, "samples": e.Samples,
				"serverTimeMs": c.ServerTimeMs(now), "serverTick": c.ServerTick(now), "tickRate": c.TickRate()}
		}),
		"newPacer": fn(func(a []js.Value) any { return put(clock.NewPacer()) }),
		"pacerDue": fn(func(a []js.Value) any {
			ticks := get[*clock.Pacer](a[0]).Due(get[*clock.Sync](a[1]), a[2].Float())
			out := make([]any, len(ticks))
			for i, t := range ticks {
				out[i] = int(t)
			}
			return out
		}),
		"pacerFeedback": fn(func(a []js.Value) any {
			get[*clock.Pacer](a[0]).OnServerFeedback(uint16(a[1].Int()), a[2].Float())
			return nil
		}),
		"pacerInfo": fn(func(a []js.Value) any {
			p := get[*clock.Pacer](a[0])
			return map[string]any{"marginTicks": p.Margin, "raises": p.Adjustments}
		}),
		"free": fn(func(a []js.Value) any {
			delete(handles, a[0].Int())
			return nil
		}),
	}
	js.Global().Set("NetcodeSim", js.ValueOf(api))
	if cb := js.Global().Get("onNetcodeSimReady"); cb.Type() == js.TypeFunction {
		cb.Invoke()
	}
	select {}
}
