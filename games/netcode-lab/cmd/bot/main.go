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
}

type ctrl struct {
	T        string          `json:"t"`
	ID       int             `json:"id"`
	Team     string          `json:"team"`
	Settings *settings       `json:"settings"`
	Spawn    map[string]any  `json:"spawn"`
	Msg      string          `json:"msg"`
	Raw      json.RawMessage `json:"-"`
}

type Summary struct {
	Name             string   `json:"name"`
	ID               int      `json:"id"`
	Seconds          float64  `json:"seconds"`
	InputsSent       uint32   `json:"inputsSent"`
	Snapshots        int      `json:"snapshots"`
	SnapshotsPerSec  float64  `json:"snapshotsPerSec"`
	Corrections      uint64   `json:"corrections"`
	Replayed         uint64   `json:"replayed"`
	AvgReplayPerSnap float64  `json:"avgReplayPerSnapshot"`
	ServerStarved    uint16   `json:"serverStarvedTicks"`
	RTTMedianMs      float64  `json:"rttMedianMs"`
	RTTMinMs         float64  `json:"rttMinMs"`
	JitterMs         float64  `json:"jitterMs"`
	AckRTTMs         float64  `json:"ackRttMs"`
	LostUp           uint64   `json:"lostUpByAcks"`
	DistanceM        float64  `json:"distanceWalkedM"`
	MaxSnapGapMs     float64  `json:"maxSnapshotGapMs"`
	PacerMarginTicks float64  `json:"pacerMarginTicks"`
	PacerRaises      int      `json:"pacerRaises"`
	Errors           []string `json:"errors,omitempty"`
}

type bot struct {
	name  string
	conn  transport.Conn
	start time.Time
	rng   *rand.Rand

	mu       sync.Mutex
	ep       codec.Endpoint
	clk      clock.Sync
	pacer    *clock.Pacer
	pred     *sim.Predictor
	set      settings
	id       int
	welcomed chan struct{}
	snaps    int
	lastSnap float64
	maxGap   float64
	starved  uint16
	errs     []string
	dist     float64
	lastPos  [3]sim.Fx
	rateCh   chan int
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
				close(b.welcomed)
			case "settings":
				if c.Settings != nil {
					b.set = *c.Settings
				}
			case "error":
				b.errs = append(b.errs, c.Msg)
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
			codec.ReadSnapshot(&r, &snap)
			if r.Err != nil {
				break
			}
			if b.lastSnap > 0 {
				b.maxGap = math.Max(b.maxGap, now-b.lastSnap)
			}
			b.lastSnap = now
			b.snaps++
			b.starved = snap.Own.Starved
			b.pacer.OnServerFeedback(snap.Own.Starved, now)
			if snap.LastProcessedInputSeq > 0 {
				b.pred.Reconcile(snap.Own.State, snap.LastProcessedInputSeq, sim.DtForRate(b.set.TickRate), b.set.Reconcile)
			}
			w.B = w.B[:0]
			codec.AppendSnapshotAck(&w, b.ep.NextHeader(codec.TSnapshotAck, now), &codec.SnapshotAck{BaselineID: snap.BaselineID, ServerTick: snap.ServerTick})
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

func run(ctx context.Context, url, name string, seed uint64) Summary {
	b := &bot{name: name, start: time.Now(), rng: rand.New(rand.NewPCG(seed, seed*7+1)),
		pred: sim.NewPredictor(sim.Courtyard(), sim.State{}), pacer: clock.NewPacer(), welcomed: make(chan struct{})}
	sum := Summary{Name: name}
	conn, err := dial(ctx, url)
	if err != nil {
		sum.Errors = append(sum.Errors, err.Error())
		return sum
	}
	b.conn = conn
	defer conn.Close("bot done")
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
				in := wk.next(b.rng, t, speed)
				seq++
				st := b.pred.Predict(sim.Cmd{Seq: seq, ClientTick: ct, In: in}, sim.DtForRate(b.set.TickRate))
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
					sum.Errors = append(sum.Errors, err.Error())
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
		Errors: append(sum.Errors, b.errs...),
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
	kind := flag.String("kind", "walker", "bot behaviour (walker)")
	flag.Parse()
	if *kind != "walker" {
		log.Fatalf("unknown -kind %q (built: walker)", *kind)
	}
	ctx := context.Background()
	var cancel context.CancelFunc
	if *dur > 0 {
		ctx, cancel = context.WithTimeout(ctx, *dur)
		defer cancel()
	}
	var wg sync.WaitGroup
	out := make([]Summary, *n)
	for i := 0; i < *n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			out[i] = run(ctx, *url, fmt.Sprintf("bot-walker-%d", i+1), uint64(i+1))
		}(i)
		time.Sleep(50 * time.Millisecond)
	}
	wg.Wait()
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.Encode(out)
}
