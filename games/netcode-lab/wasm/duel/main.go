//go:build js && wasm

// Command duel exposes the duel sim and session (sim/duel) to the browser as
// globalThis.NetcodeDuel. It is a separate binary from the shooter's
// NetcodeSim (wasm/), so the duel page loads only what it needs.
package main

import (
	"fmt"
	"strings"
	"syscall/js"

	"netcodelab/sim/duel"
)

var (
	handles = map[int]*duel.Session{}
	nextH   = 1
)

func fn(f func(a []js.Value) any) js.Func {
	return js.FuncOf(func(this js.Value, a []js.Value) any { return f(a) })
}

func sess(v js.Value) *duel.Session {
	s, ok := handles[v.Int()]
	if !ok {
		panic(fmt.Sprintf("NetcodeDuel: bad handle %d", v.Int()))
	}
	return s
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

func stateToJS(s duel.State) any {
	fs := make([]any, 2)
	for i, f := range s.F {
		fs[i] = map[string]any{"x": int(f.X), "y": int(f.Y), "hp": int(f.HP), "facing": int(f.Facing),
			"atk": int(f.Atk), "stun": int(f.Stun)}
	}
	return map[string]any{"frame": int(s.Frame), "ko": int(s.KO), "score": []any{int(s.Score[0]), int(s.Score[1])}, "f": fs}
}

func statsToJS(s *duel.Session) any {
	st := s.Stats()
	out := map[string]any{
		"frame": int(st.Frame), "delay": st.Delay, "delayAuto": st.DelayAuto, "mode": int(s.Config().Mode),
		"started":   s.Started(),
		"rollbacks": float64(st.Rollbacks), "framesRolledBack": float64(st.FramesRolledBack),
		"maxDepth": int(st.MaxDepth), "lastDepth": int(st.LastDepth), "lastRollbackAt": int(st.LastRollbackAt),
		"predicted": int(st.Predicted), "stallFrames": float64(st.StallFrames), "stallMs": st.StallMs,
		"syncWaits": float64(st.SyncWaits), "checksCompared": float64(st.ChecksCompared),
		"remoteChanges": float64(st.RemoteChanges), "packetsIn": float64(st.PacketsIn), "packetsOut": float64(st.PacketsOut),
		"rttMs": st.RTTMs, "jitterMs": st.JitterMs, "rttSamples": st.RTTSamples,
		"rollbacksPerSec": st.RollbacksPerSec, "rolledBackPerSec": st.RolledBackPerSec,
		"stallFramesPerSec": st.StallFramesPerSec, "stallMsPerSec": st.StallMsPerSec,
		"injectedAt": int(st.InjectedAt), "injectedBit": int(st.InjectedBit), "injectedFighter": int(st.InjectedFighter),
		"desync": nil,
	}
	if d := s.Desync(); d != nil {
		out["desync"] = map[string]any{"frame": int(d.Frame), "local": fmt.Sprintf("%016x", d.Local), "remote": fmt.Sprintf("%016x", d.Remote)}
	}
	return out
}

func main() {
	api := map[string]any{
		"apiVersion": 1,
		"HZ":         duel.Hz, "Q": duel.Q, "STAGE_W": duel.StageW, "W": duel.W, "H": duel.H,
		"ATK": map[string]any{"startup": duel.AtkStartup, "active": duel.AtkActive, "total": duel.AtkTotal,
			"reach": duel.AtkReach, "low": duel.AtkLow, "high": duel.AtkHigh},
		"BTN":               map[string]any{"left": int(duel.BtnLeft), "right": int(duel.BtnRight), "jump": int(duel.BtnJump), "attack": int(duel.BtnAttack)},
		"MODE":              map[string]any{"rollback": int(duel.ModeRollback), "lockstep": int(duel.ModeLockstep)},
		"MAX_ROLLBACK":      duel.MaxRollback,
		"autoDelay":         fn(func(a []js.Value) any { return duel.AutoDelay(a[0].Float()) }),
		"lockstepAutoDelay": fn(func(a []js.Value) any { return duel.LockstepAutoDelay(a[0].Float()) }),
		// newSession({side, delay (-1 = auto), mode, epoch, seed})
		"newSession": fn(func(a []js.Value) any {
			c := a[0]
			h := nextH
			nextH++
			handles[h] = duel.NewSession(duel.Config{Side: c.Get("side").Int(), Delay: c.Get("delay").Int(),
				Mode: duel.Mode(c.Get("mode").Int()), Epoch: uint16(c.Get("epoch").Int()), Seed: uint64(c.Get("seed").Int())})
			return h
		}),
		"begin":  fn(func(a []js.Value) any { sess(a[0]).Begin(); return nil }),
		"tick":   fn(func(a []js.Value) any { return sess(a[0]).Tick(uint8(a[1].Int()), a[2].Float()) }),
		"packet": fn(func(a []js.Value) any { return bytesToJS(sess(a[0]).Packet(a[1].Float())) }),
		"receive": fn(func(a []js.Value) any {
			if err := sess(a[0]).Receive(bytesFromJS(a[1]), a[2].Float()); err != nil {
				return err.Error()
			}
			return nil
		}),
		"inject": fn(func(a []js.Value) any { sess(a[0]).Inject(); return nil }),
		"state":  fn(func(a []js.Value) any { return stateToJS(sess(a[0]).State()) }),
		"stats":  fn(func(a []js.Value) any { return statsToJS(sess(a[0])) }),
		"free":   fn(func(a []js.Value) any { delete(handles, a[0].Int()); return nil }),
		// traceLines(Uint8Array inputs.bin) -> string: B.9 check 1 for the duel.
		"traceLines": fn(func(a []js.Value) any {
			in, err := duel.ParseInputs(bytesFromJS(a[0]))
			if err != nil {
				panic(err)
			}
			return strings.Join(duel.TraceLines(in), "\n") + "\n"
		}),
	}
	js.Global().Set("NetcodeDuel", js.ValueOf(api))
	if cb := js.Global().Get("onNetcodeDuelReady"); cb.Type() == js.TypeFunction {
		cb.Invoke()
	}
	select {}
}
