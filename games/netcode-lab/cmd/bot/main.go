// Command bot runs headless Go clients against the server over the real
// transport. Each bot predicts and reconciles with the shared sim package,
// exactly like the browser does through WASM, and counts corrections.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"math/rand/v2"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"netcodelab/net/clock"
	"netcodelab/net/codec"
	"netcodelab/net/transport"
	"netcodelab/sim"
)

type settings struct {
	TickRate  int  `json:"tickRate"`
	SendRate  int  `json:"sendRate"`
	Reconcile bool `json:"reconcile"`
	InterpMs  int  `json:"interpMs"`
	LagComp   bool `json:"lagcomp"`
}

type ctrl struct {
	T        string          `json:"t"`
	ID       int             `json:"id"`
	Team     string          `json:"team"`
	Settings *settings       `json:"settings"`
	Spawn    map[string]any  `json:"spawn"`
	Msg      string          `json:"msg"`
	Cond     json.RawMessage `json:"cond"`
}

type Summary struct {
	Name             string          `json:"name"`
	ID               int             `json:"id"`
	Seconds          float64         `json:"seconds"`
	InputsSent       uint32          `json:"inputsSent"`
	Snapshots        int             `json:"snapshots"`
	SnapshotsPerSec  float64         `json:"snapshotsPerSec"`
	Corrections      uint64          `json:"corrections"`
	Replayed         uint64          `json:"replayed"`
	AvgReplayPerSnap float64         `json:"avgReplayPerSnapshot"`
	ServerStarved    uint16          `json:"serverStarvedTicks"`
	RTTMedianMs      float64         `json:"rttMedianMs"`
	RTTMinMs         float64         `json:"rttMinMs"`
	JitterMs         float64         `json:"jitterMs"`
	AckRTTMs         float64         `json:"ackRttMs"`
	LostUp           uint64          `json:"lostUpByAcks"`
	DistanceM        float64         `json:"distanceWalkedM"`
	MaxSnapGapMs     float64         `json:"maxSnapshotGapMs"`
	PacerMarginTicks float64         `json:"pacerMarginTicks"`
	PacerRaises      int             `json:"pacerRaises"`
	Cond             json.RawMessage `json:"condAtWelcome,omitempty"`
	TickRate         int             `json:"tickRate"`
	CorrectionTimes  []string        `json:"correctionTimes,omitempty"`
	Brain            any             `json:"shots,omitempty"`
	BadSnapshots     int             `json:"undecodableSnapshots"`
	InterArrival     map[string]any  `json:"snapshotInterArrival,omitempty"`
	Errors           []string        `json:"errors,omitempty"`
}

type bot struct {
	name  string
	conn  transport.Conn
	start time.Time
	rng   *rand.Rand

	mu        sync.Mutex
	ep        codec.Endpoint
	clk       clock.Sync
	pacer     *clock.Pacer
	pred      *sim.Predictor
	set       settings
	id        int
	welcomed  chan struct{}
	snaps     int
	lastSnap  float64
	maxGap    float64
	starved   uint16
	errs      []string
	dist      float64
	lastPos   [3]sim.Fx
	cond      json.RawMessage
	brain     brain
	baselines codec.Baselines // v3 delta baselines by SnapID
	badSnaps  int
	gaps      []float64      // snapshot inter-arrival times (ms), P29
	corrAt    []string       // wall-clock time of each correction (first 500)
	rec       *statsRecorder // non-nil on the bot that records server stats
}

func (b *bot) now() float64 { return float64(time.Since(b.start).Nanoseconds()) / 1e6 }

func (b *bot) readLoop(ctx context.Context) {
	var snap codec.Snapshot
	var w codec.Writer
	for {
		m, err := b.conn.Recv(ctx)
		if err != nil {
			return
		}
		if m.Control {
			var c ctrl
			if json.Unmarshal(m.Data, &c) != nil {
				continue
			}
			b.mu.Lock()
			switch c.T {
			case "welcome":
				b.id = c.ID
				if c.Settings != nil {
					b.set = *c.Settings
				}
				st := sim.State{}
				num := func(k string) int32 { v, _ := c.Spawn[k].(float64); return int32(v) }
				st.Pos = [3]sim.Fx{num("x"), num("y"), num("z")}
				st.Vel = [3]sim.Fx{num("vx"), num("vy"), num("vz")}
				st.OnGround, _ = c.Spawn["onGround"].(bool)
				st.Yaw, st.Pitch = int16(num("yaw")), int16(num("pitch"))
				b.pred.Reset(st)
				b.lastPos = st.Pos
				b.cond = c.Cond
				close(b.welcomed)
			case "settings":
				if c.Settings != nil {
					b.set = *c.Settings
				}
			case "error":
				b.errs = append(b.errs, c.Msg)
			case "stats":
				if b.rec != nil {
					b.rec.add(m.Data, time.Now())
				}
			}
			b.mu.Unlock()
			continue
		}
		now := b.now()
		r := codec.Reader{B: m.Data}
		h := r.Header()
		if r.Err != nil {
			continue
		}
		b.mu.Lock()
		if dup, _ := b.ep.OnReceive(h, now); dup {
			b.mu.Unlock()
			continue
		}
		switch h.Type {
		case codec.TPong:
			var p codec.Pong
			codec.ReadPong(&r, &p)
			if r.Err == nil {
				b.clk.OnPong(p, now)
			}
		case codec.TSnapshot:
			codec.ReadSnapshotWith(&r, &snap, &b.baselines)
			if r.Err != nil {
				b.badSnaps++
				break
			}
			if b.lastSnap > 0 {
				b.maxGap = math.Max(b.maxGap, now-b.lastSnap)
				b.gaps = append(b.gaps, now-b.lastSnap)
			}
			b.lastSnap = now
			b.snaps++
			b.starved = snap.Own.Starved
			b.pacer.OnServerFeedback(snap.Own.Starved, now)
			if b.brain != nil {
				b.brain.onSnapshot(b, &snap, now)
			}
			if snap.LastProcessedInputSeq > 0 {
				before := b.pred.Corrections
				b.pred.ReconcileLife(snap.Own.State, snap.LastProcessedInputSeq, sim.DtForRate(b.set.TickRate), b.set.Reconcile, snap.Own.Life, snap.Own.Dead)
				if b.pred.Corrections != before && len(b.corrAt) < 500 {
					b.corrAt = append(b.corrAt, time.Now().Format("15:04:05.000"))
				}
			}
			w.B = w.B[:0]
			codec.AppendSnapshotAck(&w, b.ep.NextHeader(codec.TSnapshotAck, now), &codec.SnapshotAck{BaselineID: snap.SnapID, ServerTick: snap.ServerTick} /* v3: ack the snapshot id */)
			out := append([]byte(nil), w.B...)
			b.mu.Unlock()
			b.conn.SendDatagram(out)
			continue
		}
		b.mu.Unlock()
	}
}

// walker: runs around the Courtyard, turning every few seconds and when stuck.
type walker struct {
	yaw    float64
	turnAt time.Time
	strafe uint16
	jumpAt time.Time
}

func (wk *walker) next(rng *rand.Rand, now time.Time, speed float64) sim.Input {
	if now.After(wk.turnAt) || speed < 0.5 {
		wk.yaw = rng.Float64() * 2 * math.Pi
		wk.turnAt = now.Add(time.Duration(1500+rng.IntN(2500)) * time.Millisecond)
		switch rng.IntN(4) {
		case 0:
			wk.strafe = sim.BtnLeft
		case 1:
			wk.strafe = sim.BtnRight
		default:
			wk.strafe = 0
		}
	}
	wk.yaw += 0.01 // slow continuous turn so yaw changes every tick
	btn := sim.BtnForward | wk.strafe
	if now.After(wk.jumpAt) {
		btn |= sim.BtnJump
		wk.jumpAt = now.Add(time.Duration(3000+rng.IntN(4000)) * time.Millisecond)
	}
	return sim.Input{Buttons: btn, Yaw: sim.AngleFromRadians(wk.yaw)}
}

func run(ctx context.Context, url, name string, seed uint64, rec *statsRecorder, br brain) Summary {
	b := &bot{name: name, start: time.Now(), rng: rand.New(rand.NewPCG(seed, seed*7+1)),
		pred: sim.NewPredictor(sim.Courtyard(), sim.State{}), pacer: clock.NewPacer(), welcomed: make(chan struct{}), rec: rec, brain: br}
	sum := Summary{Name: name}
	conn, err := dial(ctx, url)
	if err != nil {
		sum.Errors = append(sum.Errors, err.Error())
		return sum
	}
	b.conn = conn
	defer conn.Close("bot done")
	if rec != nil {
		rec.mu.Lock()
		rec.conn = conn
		rec.mu.Unlock()
	}
	join, _ := json.Marshal(map[string]string{"t": "join", "name": name})
	if err := conn.SendControl(join); err != nil {
		sum.Errors = append(sum.Errors, err.Error())
		return sum
	}
	go b.readLoop(ctx)
	select {
	case <-b.welcomed:
	case <-ctx.Done():
		sum.Errors = append(sum.Errors, "no welcome")
		return sum
	}

	tk := time.NewTicker(2 * time.Millisecond) // inputs are paced by the synced clock, not this ticker
	ping := time.NewTicker(250 * time.Millisecond)
	defer tk.Stop()
	defer ping.Stop()
	sendPing := func() {
		b.mu.Lock()
		now := b.now()
		w := codec.Writer{}
		codec.AppendPing(&w, b.ep.NextHeader(codec.TPing, now), &codec.Ping{ClientSendMs: now})
		b.mu.Unlock()
		conn.SendDatagram(w.B)
	}
	sendPing()
	var wk walker
	var seq uint32
	var w codec.Writer
	t0 := time.Now()
loop:
	for {
		select {
		case <-ctx.Done():
			break loop
		case <-ping.C:
			sendPing()
		case t := <-tk.C:
			b.mu.Lock()
			now := b.now()
			ticks := b.pacer.Due(&b.clk, now)
			var outs [][]byte
			for _, ct := range ticks {
				speed := sim.ToFloat(sim.Length2(b.pred.State.Vel[0], b.pred.State.Vel[2]))
				if seq < 10 {
					speed = 1 // do not "turn when stuck" before moving
				}
				seq++
				var c sim.Cmd
				if b.brain != nil {
					c = b.brain.cmd(b, now, seq)
				} else {
					c.In = wk.next(b.rng, t, speed)
				}
				c.Seq, c.ClientTick = seq, ct
				st := b.pred.Predict(c, sim.DtForRate(b.set.TickRate))
				b.dist += sim.ToFloat(sim.Length2(st.Pos[0]-b.lastPos[0], st.Pos[2]-b.lastPos[2]))
				b.lastPos = st.Pos
				pending := b.pred.Pending()
				w.B = w.B[:0]
				codec.AppendInput(&w, b.ep.NextHeader(codec.TInput, now), &codec.Input{Cmds: pending[max(0, len(pending)-codec.MaxCmds):]})
				outs = append(outs, append([]byte(nil), w.B...))
			}
			b.mu.Unlock()
			for _, out := range outs {
				if err := conn.SendDatagram(out); err != nil {
					if ctx.Err() == nil { // after the deadline the transport closes itself: not a run error
						sum.Errors = append(sum.Errors, err.Error())
					}
					break loop
				}
			}
		}
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	e := b.clk.Estimate()
	es := b.ep.Snapshot()
	secs := time.Since(t0).Seconds()
	sum = Summary{
		Name: name, ID: b.id, Seconds: math.Round(secs*10) / 10, InputsSent: seq, Snapshots: b.snaps,
		SnapshotsPerSec: math.Round(float64(b.snaps)/secs*10) / 10,
		Corrections:     b.pred.Corrections, Replayed: b.pred.Replayed,
		ServerStarved: b.starved, RTTMedianMs: round2(e.RTTMs), RTTMinMs: round2(e.MinRTTMs), JitterMs: round2(e.JitterMs),
		AckRTTMs: round2(es.RTTMs), LostUp: es.Lost, DistanceM: math.Round(b.dist), MaxSnapGapMs: round2(b.maxGap), PacerMarginTicks: b.pacer.Margin, PacerRaises: b.pacer.Adjustments,
		Cond: b.cond, TickRate: b.set.TickRate, CorrectionTimes: b.corrAt,
		Errors: append(sum.Errors, b.errs...),
	}
	if b.brain != nil {
		sum.Brain = b.brain.report()
	}
	sum.BadSnapshots = b.badSnaps
	if len(b.gaps) > 0 && b.set.SendRate > 0 {
		sum.InterArrival = interArrival(b.gaps, 1000/float64(b.set.SendRate))
	}
	if b.snaps > 0 {
		sum.AvgReplayPerSnap = round2(float64(b.pred.Replayed) / float64(b.snaps))
	}
	return sum
}

// dial picks the transport from the URL: ws:// = WebSocket, https:// = WebTransport
// (the cert hash is fetched from -info, like the browser does).
func dial(ctx context.Context, url string) (transport.Conn, error) {
	if !strings.HasPrefix(url, "https://") {
		return transport.DialWS(ctx, url)
	}
	resp, err := http.Get(*infoURL + "/certhash")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var ch struct {
		Base64 string `json:"base64"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&ch); err != nil {
		return nil, err
	}
	hash, err := base64.StdEncoding.DecodeString(ch.Base64)
	if err != nil {
		return nil, err
	}
	return transport.DialWT(ctx, url, hash)
}

var infoURL = flag.String("info", "http://127.0.0.1:8080", "plain-HTTP base URL serving /certhash (for https:// WebTransport URLs)")

func round2(v float64) float64 { return math.Round(v*100) / 100 }

func main() {
	url := flag.String("url", "ws://127.0.0.1:8080/ws", "server URL: ws://host:8080/ws (WebSocket) or https://host:8443/wt (WebTransport)")
	n := flag.Int("n", 1, "number of bots")
	dur := flag.Duration("d", 30*time.Second, "how long to run (0 = until Ctrl-C)")
	kind := flag.String("kind", "walker", "walker = bots; probe = no-network control that sleeps on the server's tick schedule and reports late wake-ups (check 2)")
	probeHz := flag.Int("hz", 64, "with -kind probe: tick rate to sleep on")
	tick := flag.Int("tick", 0, "set the server tick rate (20/30/64/128) through the Lab before the bots join; needs -token")
	condAll := flag.String("cond", "", `conditioner for every player and new joiners, as JSON {"up":{...},"down":{...}} (keys delayMs, jitterMs, lossPct, dupPct, reorderPct); needs -token`)
	lab := flag.String("lab", "", `extra Lab settings to apply before the bots join, as JSON (e.g. '{"speedScale":0.8}'); needs -token`)
	token := flag.String("token", os.Getenv("NETLAB_ADMIN_TOKEN"), "admin token for -tick (default $NETLAB_ADMIN_TOKEN)")
	stats := flag.Bool("stats", false, "record the server's 1 Hz tick stats (via bot 1) and print a load report")
	warmup := flag.Duration("warmup", 10*time.Second, "with -stats: stats received in the first warmup after the last bot joined are not counted")
	statsReset := flag.Bool("statsreset", false, "with -stats and -token: send statsReset after the warmup so the server's whole-window histograms cover only the measured window (off by default: a fresh server's window already starts at the run)")
	perBot := flag.Bool("perbot", true, "print one summary per bot (false: totals only)")
	flag.Parse()
	if *kind != "walker" && *kind != "probe" && *kind != "shootrun" {
		log.Fatalf("unknown -kind %q (built: walker, probe, shootrun)", *kind)
	}
	ctx := context.Background()
	var cancel context.CancelFunc
	if *dur > 0 {
		ctx, cancel = context.WithTimeout(ctx, *dur)
		defer cancel()
	}
	if *kind == "probe" {
		runProbe(ctx, *probeHz)
		return
	}
	if *tick > 0 {
		if err := setTickRate(ctx, *url, *token, *tick); err != nil {
			log.Fatalf("-tick %d: %v", *tick, err)
		}
	}
	if *condAll != "" {
		var m map[string]any
		if err := json.Unmarshal([]byte(*condAll), &m); err != nil {
			log.Fatalf("-cond: %v", err)
		}
		if err := applyCondAll(ctx, *url, *token, m); err != nil {
			log.Fatalf("-cond %s: %v", *condAll, err)
		}
	}
	if *lab != "" {
		var m map[string]any
		if err := json.Unmarshal([]byte(*lab), &m); err != nil {
			log.Fatalf("-lab: %v", err)
		}
		if err := applyLab(ctx, *url, *token, m); err != nil {
			log.Fatalf("-lab %s: %v", *lab, err)
		}
	}
	if *kind == "shootrun" {
		// B.9 check 3 integration: the shooter joins first (blue), the runner second (orange).
		var wg sync.WaitGroup
		out := make([]Summary, 2)
		var rec *statsRecorder
		if *stats {
			rec = &statsRecorder{token: *token}
		}
		wg.Add(2)
		go func() { defer wg.Done(); out[0] = run(ctx, *url, "bot-shooter", 1, rec, newShooter()) }()
		time.Sleep(300 * time.Millisecond)
		go func() { defer wg.Done(); out[1] = run(ctx, *url, "bot-runner", 2, nil, &runner{}) }()
		if rec != nil {
			rec.setFrom(time.Now())
		}
		wg.Wait()
		res := map[string]any{"kind": "shootrun", "perBot": out}
		if rec != nil {
			res["serverTick"] = rec.report(2)
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		enc.Encode(res)
		return
	}
	var rec *statsRecorder
	if *stats {
		rec = &statsRecorder{token: *token}
	}
	var wg sync.WaitGroup
	out := make([]Summary, *n)
	for i := 0; i < *n; i++ {
		wg.Add(1)
		var r *statsRecorder
		if i == 0 {
			r = rec
		}
		go func(i int) {
			defer wg.Done()
			out[i] = run(ctx, *url, fmt.Sprintf("bot-walker-%d", i+1), uint64(i+1), r, nil)
		}(i)
		time.Sleep(50 * time.Millisecond)
	}
	if rec != nil {
		rec.setFrom(time.Now().Add(*warmup))
		if rec.token != "" && *statsReset {
			go func() {
				select {
				case <-time.After(*warmup):
					if err := rec.reset(); err != nil {
						log.Printf("statsReset: %v", err)
					}
				case <-ctx.Done():
				}
			}()
		}
	}
	wg.Wait()
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	res := map[string]any{"bots": len(out), "totals": totals(out)}
	if *perBot {
		res["perBot"] = out
	}
	if rec != nil {
		res["serverTick"] = rec.report(*n)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.Encode(res)
}
