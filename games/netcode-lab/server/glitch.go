package server

import (
	"time"

	"netcodelab/net/cond"
)

// P25 glitch lab (A.14): reproducible glitches, each named on screen.

const (
	rubberBandScale = 0.6
	maxBurstMs      = 3000
)

var glitchText = map[string][2]string{
	"rubberband": {"Rubber-banding", "The server moves you at 60% speed and your client does not know: every snapshot corrects your prediction back (A.14, server-only speed modifier)."},
	"lossBurst":  {"Teleporting", "Every snapshot is lost for longer than the interpolation buffer: other players freeze, then jump to where they are now (A.14)."},
}

// handleGlitch: {t:"glitch", token, kind:"rubberband", on:bool} or
// {t:"glitch", token, kind:"lossBurst", ms?:400, target?:id, all?:bool}.
func (r *Room) handleGlitch(c *Client, in ctrlIn) {
	if !r.checkToken(in.Token) {
		r.errorTo(c, "glitch: bad admin token")
		return
	}
	txt, ok := glitchText[in.Kind]
	if !ok {
		r.errorTo(c, "glitch: unknown kind (rubberband | lossBurst)")
		return
	}
	msg := map[string]any{"t": "glitch", "kind": in.Kind, "name": txt[0], "explain": txt[1], "serverTimeMs": r.NowMs()}
	switch in.Kind {
	case "rubberband":
		r.mu.Lock()
		s := r.settings
		r.mu.Unlock()
		s.SpeedScale = 1
		if in.On {
			s.SpeedScale = rubberBandScale
		}
		r.applySettings(s, "P25")
		msg["on"] = in.On
		msg["speedScale"] = s.SpeedScale
	case "lossBurst":
		ms := in.Ms
		if ms <= 0 {
			ms = 400
		}
		ms = min(ms, maxBurstMs)
		var targets []*Client
		r.mu.Lock()
		for _, o := range r.clients {
			if in.All || (in.Target == 0 && o == c) || int(o.id) == in.Target {
				targets = append(targets, o)
			}
		}
		r.mu.Unlock()
		for _, t := range targets {
			prev := t.down.Params()
			burst := prev
			burst.LossPct = 100
			t.down.SetParams(burst)
			time.AfterFunc(time.Duration(ms)*time.Millisecond, func() { restoreLoss(t.down, prev) })
		}
		msg["ms"] = ms
		msg["targets"] = len(targets)
		r.log.Info("glitch loss burst", "ms", ms, "targets", len(targets))
	}
	r.broadcast(msg)
}

// restoreLoss puts the loss back unless someone changed the link meanwhile.
func restoreLoss(l *cond.Link, prev cond.Params) {
	if l.Closed() { // the player left during the burst (review V17)
		return
	}
	cur := l.Params()
	if cur.LossPct == 100 {
		cur.LossPct = prev.LossPct
		l.SetParams(cur)
	}
}
