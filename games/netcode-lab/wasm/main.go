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

func decode(ep *codec.Endpoint, b []byte, now float64) any {
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
		codec.ReadSnapshot(&r, &s)
		ents := make([]any, len(s.Entities))
		for i, e := range s.Entities {
			ents[i] = map[string]any{"id": int(e.ID), "team": int(e.Team), "x": int(e.Pos[0]), "y": int(e.Pos[1]), "z": int(e.Pos[2]),
				"yaw": int(e.Yaw), "pitch": int(e.Pitch), "health": int(e.Health), "anim": int(e.Anim)}
		}
		evs := make([]any, len(s.Events))
		for i, e := range s.Events {
			evs[i] = map[string]any{"type": int(e.Type), "data": bytesToJS(e.Data)}
		}
		out["type"] = "snapshot"
		out["serverTick"] = int(s.ServerTick)
		out["serverTimeMs"] = s.ServerTimeMs
		out["lastProcessedInputSeq"] = int(s.LastProcessedInputSeq)
		out["own"] = map[string]any{"state": stateToJS(s.Own.State), "health": int(s.Own.Health), "inputBuffer": int(s.Own.InputBuffer),
			"starved": int(s.Own.Starved), "inputLead": int(s.Own.InputLead)}
		out["baselineId"] = int(s.BaselineID)
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

func pongFromJS(v js.Value) codec.Pong {
	return codec.Pong{
		ClientSendMs: v.Get("clientSendMs").Float(), ServerRecvMs: v.Get("serverRecvMs").Float(), ServerSendMs: v.Get("serverSendMs").Float(),
		ServerTick: uint32(v.Get("serverTick").Int()), TickFrac: uint16(v.Get("tickFrac").Int()), TickRate: uint16(v.Get("tickRate").Int()),
	}
}

func main() {
	api := map[string]any{
		"apiVersion":      1,
		"protocolVersion": 1,
		"FX":              int(sim.One),
		"BTN": map[string]any{"forward": int(sim.BtnForward), "back": int(sim.BtnBack), "left": int(sim.BtnLeft),
			"right": int(sim.BtnRight), "jump": int(sim.BtnJump), "fire": int(sim.BtnFire)},
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
			r := p.Reconcile(stateFromJS(a[1]), uint32(a[2].Int()), sim.Fx(a[3].Int()), a[4].Truthy())
			return map[string]any{"state": stateToJS(p.State), "corrected": r.Corrected, "replayed": r.Replayed,
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

		"newConn": fn(func(a []js.Value) any { return put(&codec.Endpoint{}) }),
		"encodeInput": fn(func(a []js.Value) any {
			ep := get[*codec.Endpoint](a[0])
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
			ep := get[*codec.Endpoint](a[0])
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
			ep := get[*codec.Endpoint](a[0])
			now := a[1].Float()
			var w codec.Writer
			codec.AppendPing(&w, ep.NextHeader(codec.TPing, now), &codec.Ping{ClientSendMs: now})
			return bytesToJS(w.B)
		}),
		"encodeSnapshotAck": fn(func(a []js.Value) any {
			ep := get[*codec.Endpoint](a[0])
			var w codec.Writer
			codec.AppendSnapshotAck(&w, ep.NextHeader(codec.TSnapshotAck, a[3].Float()),
				&codec.SnapshotAck{BaselineID: uint8(a[1].Int()), ServerTick: uint32(a[2].Int())})
			return bytesToJS(w.B)
		}),
		"decode": fn(func(a []js.Value) any {
			return decode(get[*codec.Endpoint](a[0]), bytesFromJS(a[1]), a[2].Float())
		}),
		"connStats": fn(func(a []js.Value) any {
			s := get[*codec.Endpoint](a[0]).Snapshot()
			return map[string]any{"sent": float64(s.Sent), "acked": float64(s.Acked), "lost": float64(s.Lost), "rttMs": s.RTTMs,
				"received": float64(s.Received), "duplicates": float64(s.Duplicates), "old": float64(s.Old), "remoteGaps": float64(s.RemoteGaps)}
		}),

		"newClock": fn(func(a []js.Value) any { return put(&clock.Sync{}) }),
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
