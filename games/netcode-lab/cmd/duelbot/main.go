// Command duelbot is a headless duel peer (A.13). It runs the same sim/duel
// session as the browser, over the real relay.
//
//	duelbot -room duel                      # one bot peer: the opponent for a browser tab
//	duelbot -pair -mode rollback -delay 0 -profile bad -d 30s   # two bots, prints measured stats
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"netcodelab/net/transport"
	"netcodelab/sim/duel"
)

type opts struct {
	url, info, room, profile string
	mode                     int
	delay                    int
	dur, warmup              time.Duration
	seed                     uint64
	pair                     bool
}

type result struct {
	Side             int     `json:"side"`
	Transport        string  `json:"transport"`
	Profile          string  `json:"profile"`
	Mode             string  `json:"mode"`
	Delay            int     `json:"delay"`
	DelayAuto        bool    `json:"delayAuto"`
	Seconds          float64 `json:"seconds"`
	Frames           int32   `json:"frames"`
	FPS              float64 `json:"fps"`
	Rollbacks        uint64  `json:"rollbacks"`
	RollbacksPerSec  float64 `json:"rollbacksPerSec"`
	FramesRolledBack uint64  `json:"framesRolledBack"`
	RolledBackPerSec float64 `json:"framesRolledBackPerSec"`
	AvgDepth         float64 `json:"avgDepth"`
	MaxDepth         int32   `json:"maxDepth"`
	StallFrames      uint64  `json:"stallFrames"`
	StallMs          float64 `json:"stallMs"`
	StallFramesPerS  float64 `json:"stallFramesPerSec"`
	SyncWaits        uint64  `json:"syncWaits"`
	RTTMs            float64 `json:"peerRttMs"`
	JitterMs         float64 `json:"peerJitterMs"`
	RemoteChangesPS  float64 `json:"opponentInputChangesPerSec"`
	ChecksCompared   uint64  `json:"checksCompared"`
	Desync           string  `json:"desync"`
}

func modeName(m int) string {
	if m == int(duel.ModeLockstep) {
		return "lockstep"
	}
	return "rollback"
}

func dial(o opts) (transport.Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if len(o.url) > 8 && o.url[:8] == "https://" {
		resp, err := http.Get(o.info)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		var info struct {
			WT struct {
				CertHashBase64 string `json:"certHashBase64"`
			} `json:"wt"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
			return nil, err
		}
		h, err := base64.StdEncoding.DecodeString(info.WT.CertHashBase64)
		if err != nil {
			return nil, err
		}
		return transport.DialWT(ctx, o.url, h)
	}
	return transport.DialWS(ctx, o.url)
}

// peer runs one duel peer. initiator sends the restart that fixes mode/delay.
// With stopAfter > 0 it returns the stats of the first configured match after
// that long; otherwise it plays until the connection closes.
func peer(o opts, name string, initiator bool, seed uint64, stopAfter time.Duration, out chan<- *result, quit <-chan struct{}) error {
	c, err := dial(o)
	if err != nil {
		return err
	}
	reported := false
	defer c.Close("bye")
	ctl := func(v any) { b, _ := json.Marshal(v); c.SendControl(b) }
	ctl(map[string]any{"t": "join", "room": o.room, "name": name, "bot": true})
	if o.profile != "" {
		ctl(map[string]any{"t": "cond", "profile": o.profile})
	}
	msgs := make(chan transport.Msg, 1024)
	go func() {
		for {
			m, err := c.Recv(context.Background())
			if err != nil {
				close(msgs)
				return
			}
			msgs <- m
		}
	}()
	var (
		s        *duel.Session
		startAt  time.Time
		begunAt  time.Time
		epochCfg = false
		bot      = duel.NewBotInput(seed)
		profile  = "default"
	)
	t0 := time.Now()
	nowMs := func() float64 { return float64(time.Since(t0).Microseconds()) / 1000 }
	slots := 0
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-quit:
			return nil
		case m, ok := <-msgs:
			if !ok {
				return fmt.Errorf("%s: connection closed", name)
			}
			if !m.Control {
				if s != nil {
					s.Receive(m.Data, nowMs())
				}
				continue
			}
			var v map[string]any
			json.Unmarshal(m.Data, &v)
			switch v["t"] {
			case "error":
				return fmt.Errorf("%s: %v", name, v["error"])
			case "cond":
				profile, _ = v["profile"].(string)
			case "peerLeft":
				if stopAfter > 0 && !reported {
					return fmt.Errorf("%s: peer left", name)
				}
				s = nil
			case "start":
				epoch := int(v["epoch"].(float64))
				mode, delay := int(v["mode"].(float64)), int(v["delay"].(float64))
				if o.pair && initiator && (mode != o.mode || delay != o.delay) {
					ctl(map[string]any{"t": "restart", "mode": o.mode, "delay": o.delay})
				}
				epochCfg = !o.pair || (mode == o.mode && delay == o.delay)
				s = duel.NewSession(duel.Config{Side: int(v["side"].(float64)), Delay: delay, Mode: duel.Mode(mode),
					Epoch: uint16(epoch), Seed: uint64(v["seed"].(float64)) + uint64(v["side"].(float64))})
				startAt, begunAt = time.Now(), time.Time{}
				slots = int(time.Since(t0) / (time.Second / duel.Hz))
				log.Printf("%s: start epoch %d side %v mode %s delay %d", name, epoch, v["side"], modeName(mode), delay)
			}
		case <-tick.C:
			if s == nil {
				continue
			}
			due := int(time.Since(t0)/(time.Second/duel.Hz)) - slots
			for k := 0; k < min(due, 4); k++ {
				if !s.Started() && time.Since(startAt) >= o.warmup {
					s.Begin()
					begunAt = time.Now()
				}
				s.Tick(bot.Next(), nowMs())
				c.SendDatagram(s.Packet(nowMs()))
			}
			slots += due
			if !reported && stopAfter > 0 && epochCfg && !begunAt.IsZero() && time.Since(begunAt) >= stopAfter {
				st := s.Stats()
				secs := time.Since(begunAt).Seconds()
				r := &result{Side: s.Config().Side, Transport: string(c.Kind()), Profile: profile, Mode: modeName(int(s.Config().Mode)),
					Delay: st.Delay, DelayAuto: st.DelayAuto, Seconds: secs, Frames: st.Frame, FPS: float64(st.Frame) / secs,
					Rollbacks: st.Rollbacks, RollbacksPerSec: float64(st.Rollbacks) / secs,
					FramesRolledBack: st.FramesRolledBack, RolledBackPerSec: float64(st.FramesRolledBack) / secs,
					MaxDepth: st.MaxDepth, StallFrames: st.StallFrames, StallMs: st.StallMs, StallFramesPerS: float64(st.StallFrames) / secs,
					SyncWaits: st.SyncWaits, RTTMs: st.RTTMs, JitterMs: st.JitterMs, RemoteChangesPS: float64(st.RemoteChanges) / secs,
					ChecksCompared: st.ChecksCompared, Desync: "none"}
				if st.Rollbacks > 0 {
					r.AvgDepth = float64(st.FramesRolledBack) / float64(st.Rollbacks)
				}
				if d := s.Desync(); d != nil {
					r.Desync = fmt.Sprintf("frame %d local %016x remote %016x", d.Frame, d.Local, d.Remote)
				}
				reported = true
				out <- r
			}
		}
	}
}

func main() {
	var o opts
	var delay, mode string
	flag.StringVar(&o.url, "url", "ws://127.0.0.1:8090/duel/ws", "relay URL: ws://…/duel/ws or https://…/duel/wt (WebTransport)")
	flag.StringVar(&o.info, "info", "http://127.0.0.1:8090/api/duel/info", "relay info URL (WebTransport cert hash)")
	flag.StringVar(&o.room, "room", "duel", "relay room")
	flag.StringVar(&o.profile, "profile", "", "conditioner profile for this bot's link: lan, default, bad (empty: relay default)")
	flag.StringVar(&mode, "mode", "rollback", "rollback or lockstep (-pair)")
	flag.StringVar(&delay, "delay", "auto", "input delay D: auto or a frame count (-pair)")
	flag.DurationVar(&o.dur, "d", 30*time.Second, "measured match length (-pair)")
	flag.DurationVar(&o.warmup, "warmup", time.Second, "ping-only time before frame 0 (auto D needs a ping)")
	flag.Uint64Var(&o.seed, "seed", 1, "bot input seed")
	flag.BoolVar(&o.pair, "pair", false, "run two bot peers against each other and print measured stats")
	flag.Parse()
	o.mode = int(duel.ModeRollback)
	if mode == "lockstep" {
		o.mode = int(duel.ModeLockstep)
	}
	o.delay = -1
	if delay != "auto" {
		d, err := strconv.Atoi(delay)
		if err != nil {
			log.Fatal("bad -delay")
		}
		o.delay = d
	}
	if !o.pair {
		if err := peer(o, "bot", false, o.seed, 0, nil, nil); err != nil {
			log.Fatal(err)
		}
		return
	}
	if o.room == "duel" {
		o.room = fmt.Sprintf("pair-%d", time.Now().UnixNano())
	}
	var wg sync.WaitGroup
	out := make(chan *result, 2)
	errc := make(chan error, 2)
	quit := make(chan struct{})
	for i := range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := peer(o, fmt.Sprintf("bot%d", i), i == 0, o.seed*10+uint64(i), o.dur, out, quit); err != nil {
				errc <- err
			}
		}()
		time.Sleep(200 * time.Millisecond)
	}
	enc := json.NewEncoder(os.Stdout)
	res := map[int]*result{}
	for len(res) < 2 {
		select {
		case r := <-out:
			res[r.Side] = r
		case err := <-errc:
			log.Fatal(err)
		}
	}
	close(quit) // both measured: only now do the peers disconnect
	wg.Wait()
	enc.Encode(res[0])
	enc.Encode(res[1])
}
