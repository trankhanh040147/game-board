// Command beaconbot simulates players pinging the region beacons (A.12, P17,
// P20). Each player has an ISP and a last mile (most good, some on congested
// Wi-Fi, a few on a bad line: simulated). Every round it sends 10 pings to each
// region's beacon, takes the median for its RTT map, reports every sample to
// /api/infra/report (Prometheus), and can open a matchmaking ticket.
// At the end it prints mean, p50, p95, p99 per region × ISP of its own samples.
//
//	beaconbot -base http://127.0.0.1:18720 -n 30 -d 2m
package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"math/rand/v2"
	"net/http"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"netcodelab/net/transport"
)

var (
	regions = []string{"hcm", "hn", "sg"}
	isps    = []string{"viettel", "vnpt", "fpt"}
)

// cutNow mirrors the server's cable-cut state (polled), so every sample is filed under the state it was taken in.
var cutNow atomic.Bool

func cutKey() string {
	if cutNow.Load() {
		return "cut"
	}
	return "normal"
}

type agg struct {
	mu      sync.Mutex
	samples map[string][]float64 // "region/isp" -> rtts
	sent    map[string]int
	lost    map[string]int
	jit     map[string][2]float64 // sum of per-round jitter, rounds (one player's 10 pings = one round)
}

func pct(s []float64, p float64) float64 {
	if len(s) == 0 {
		return 0
	}
	c := slices.Clone(s)
	slices.Sort(c)
	return c[min(len(c)-1, int(math.Ceil(p/100*float64(len(c))))-1)]
}

func median(s []float64) float64 { return pct(s, 50) }

type opts struct {
	base, wtBase string
	certHash     []byte
	useWT        bool
	every        time.Duration
	ticket       bool
	route        string
}

func dial(o opts, region, isp, lm string) (transport.Conn, error) {
	q := fmt.Sprintf("?isp=%s&lm=%s&route=%s&platform=bot", isp, lm, o.route)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if o.useWT {
		return transport.DialWT(ctx, o.wtBase+"/beacon/"+region+"/wt"+q, o.certHash)
	}
	return transport.DialWS(ctx, strings.Replace(o.base, "http", "ws", 1)+"/beacon/"+region+"/ws"+q)
}

// ping sends n pings 20 ms apart and waits up to 1 s after the last for echoes.
type echo struct {
	b  []byte
	at time.Time
}

func ping(c transport.Conn, in <-chan echo, n int) (rtts []float64, lost int) {
	t0 := time.Now()
	sentAt := map[uint32]time.Time{}
	base := rand.Uint32()
	for i := range n {
		b := make([]byte, 12)
		binary.LittleEndian.PutUint32(b, base+uint32(i))
		sentAt[base+uint32(i)] = time.Now()
		c.SendDatagram(b)
		time.Sleep(20 * time.Millisecond)
	}
	deadline := time.After(time.Until(t0.Add(time.Duration(n)*20*time.Millisecond + time.Second)))
	got := map[uint32]bool{}
	for len(got) < n {
		select {
		case e := <-in:
			b := e.b
			if len(b) < 4 {
				continue
			}
			s := binary.LittleEndian.Uint32(b)
			if at, ok := sentAt[s]; ok && !got[s] {
				got[s] = true
				rtts = append(rtts, float64(e.at.Sub(at).Microseconds())/1000)
			}
		case <-deadline:
			return rtts, n - len(got)
		}
	}
	return rtts, 0
}

func player(o opts, id int, isp, lm string, stop <-chan struct{}, a *agg, logTicket bool) {
	conns := map[string]transport.Conn{}
	ins := map[string]chan echo{}
	for _, rg := range regions {
		c, err := dial(o, rg, isp, lm)
		if err != nil {
			log.Printf("p%d %s: %v", id, rg, err)
			return
		}
		defer c.Close("bye")
		// The server sees a WebTransport control stream only once something is written on it.
		c.SendControl([]byte(`{"t":"hello"}`))
		ch := make(chan echo, 64)
		ready := make(chan struct{})
		go func() {
			once := false
			for {
				m, err := c.Recv(context.Background())
				if err != nil {
					return
				}
				if !m.Control {
					ch <- echo{m.Data, time.Now()}
				} else if !once {
					once = true
					close(ready) // the beacon's {"t":"ready"}: pings sent before it would read as RTT
				}
			}
		}()
		select {
		case <-ready:
		case <-time.After(3 * time.Second):
			log.Printf("p%d %s: no ready from the beacon", id, rg)
			return
		}
		conns[rg], ins[rg] = c, ch
	}
	tk := time.NewTicker(o.every)
	defer tk.Stop()
	first := true
	for {
		rttMap := map[string]float64{}
		for _, rg := range regions {
			rtts, lost := ping(conns[rg], ins[rg], 10)
			rttMap[rg] = median(rtts)
			k := rg + "/" + isp + "/" + cutKey()
			a.mu.Lock()
			a.samples[k] = append(a.samples[k], rtts...)
			a.sent[k] += 10
			if len(rtts) > 1 {
				j := a.jit[k]
				a.jit[k] = [2]float64{j[0] + jitter(rtts), j[1] + 1}
			}
			a.lost[k] += lost
			a.mu.Unlock()
			body, _ := json.Marshal(map[string]any{"region": rg, "isp": isp, "platform": "bot", "rtts": rtts, "sent": 10, "lost": lost})
			if r, err := http.Post(o.base+"/api/infra/report", "application/json", bytes.NewReader(body)); err == nil {
				r.Body.Close()
			}
		}
		if o.ticket && first {
			first = false
			go ticket(o, id, isp, lm, rttMap, logTicket)
		}
		select {
		case <-stop:
			return
		case <-tk.C:
		}
	}
}

func ticket(o opts, id int, isp, lm string, rtt map[string]float64, show bool) {
	body, _ := json.Marshal(map[string]any{"player": fmt.Sprintf("bot%d", id), "isp": isp, "lm": lm, "platform": "bot", "rtt": rtt})
	r, err := http.Post(o.base+"/api/mm/ticket", "application/json", bytes.NewReader(body))
	if err != nil {
		return
	}
	var st map[string]any
	json.NewDecoder(r.Body).Decode(&st)
	r.Body.Close()
	for st["state"] == "searching" {
		time.Sleep(500 * time.Millisecond)
		r, err := http.Get(o.base + "/api/mm/ticket/" + st["id"].(string))
		if err != nil {
			return
		}
		st = map[string]any{}
		json.NewDecoder(r.Body).Decode(&st)
		r.Body.Close()
	}
	if show {
		b, _ := json.Marshal(map[string]any{"ticket": st["id"], "isp": isp, "lm": lm, "rtt": rtt, "state": st["state"], "region": st["region"], "waitedS": st["waitedS"], "events": st["events"]})
		fmt.Fprintln(os.Stderr, string(b))
	}
}

func main() {
	var o opts
	n := flag.Int("n", 30, "simulated players (spread over ISPs)")
	d := flag.Duration("d", time.Minute, "run time")
	flag.StringVar(&o.base, "base", "http://127.0.0.1:18720", "infra HTTP base URL")
	wt := flag.String("wt", "", "infra HTTPS base for WebTransport beacons (e.g. https://127.0.0.1:18721); empty: WebSocket")
	flag.DurationVar(&o.every, "every", time.Second, "ping round interval per player")
	flag.BoolVar(&o.ticket, "ticket", true, "open one matchmaking ticket per player after the first round")
	flag.StringVar(&o.route, "route", "direct", "route: direct, relay-public, relay-backbone")
	seed := flag.Uint64("seed", 1, "seed for ISP and last-mile assignment")
	cutAt := flag.Duration("cut-at", 0, "if > 0: turn the cable cut on at this time (needs NETLAB_ADMIN_TOKEN)")
	cutFor := flag.Duration("cut-for", 0, "how long the cable cut lasts (0: until the end)")
	flag.Parse()
	if *wt != "" {
		r, err := http.Get(o.base + "/api/infra/info")
		if err != nil {
			log.Fatal(err)
		}
		var info struct {
			WT struct{ CertHashBase64 string } `json:"wt"`
		}
		json.NewDecoder(r.Body).Decode(&info)
		r.Body.Close()
		o.certHash, _ = base64.StdEncoding.DecodeString(info.WT.CertHashBase64)
		o.useWT, o.wtBase = true, *wt
	}
	pollCut := func() {
		if r, err := http.Get(o.base + "/api/regions"); err == nil {
			var v struct {
				CableCut bool `json:"cableCut"`
			}
			json.NewDecoder(r.Body).Decode(&v)
			r.Body.Close()
			cutNow.Store(v.CableCut)
		}
	}
	pollCut() // before the first round, so no sample is filed under a stale state
	stopPoll := make(chan struct{})
	go func() {
		for {
			select {
			case <-stopPoll:
				return
			case <-time.After(250 * time.Millisecond):
				pollCut()
			}
		}
	}()
	defer close(stopPoll)
	rng := rand.New(rand.NewPCG(*seed, 7))
	a := &agg{samples: map[string][]float64{}, sent: map[string]int{}, lost: map[string]int{}, jit: map[string][2]float64{}}
	stop := make(chan struct{})
	var wg sync.WaitGroup
	mix := map[string]int{}
	for i := range *n {
		isp := isps[i%len(isps)]
		lm := "good"
		switch x := rng.IntN(100); {
		case x < 5:
			lm = "bad"
		case x < 20:
			lm = "wifi"
		}
		mix[isp+"/"+lm]++
		wg.Add(1)
		go func() { defer wg.Done(); player(o, i, isp, lm, stop, a, i < 6) }()
		time.Sleep(o.every / time.Duration(*n))
	}
	start := time.Now()
	cut := func(on bool) {
		body, _ := json.Marshal(map[string]any{"on": on, "token": os.Getenv("NETLAB_ADMIN_TOKEN")})
		r, err := http.Post(o.base+"/api/regions/cut", "application/json", bytes.NewReader(body))
		if err != nil || r.StatusCode != 200 {
			log.Fatalf("cable cut %v failed: %v %v", on, err, r)
		}
		r.Body.Close()
		cutNow.Store(on)
		fmt.Fprintf(os.Stderr, "cable cut %v at %.0f s\n", on, time.Since(start).Seconds())
	}
	if *cutAt > 0 {
		time.AfterFunc(*cutAt, func() { cut(true) })
		if *cutFor > 0 {
			time.AfterFunc(*cutAt+*cutFor, func() { cut(false) })
		}
	}
	time.Sleep(*d)
	close(stop)
	wg.Wait()
	fmt.Fprintf(os.Stderr, "player mix (isp/last mile): %v\n", mix)
	enc := json.NewEncoder(os.Stdout)
	for _, cs := range []string{"normal", "cut"} {
		for _, rg := range regions {
			for _, isp := range isps {
				k := rg + "/" + isp + "/" + cs
				s := a.samples[k]
				if len(s) == 0 {
					continue
				}
				var sum float64
				for _, v := range s {
					sum += v
				}
				mean := 0.0
				if len(s) > 0 {
					mean = sum / float64(len(s))
				}
				enc.Encode(map[string]any{"region": rg, "isp": isp, "route": o.route, "cableCut": cs == "cut", "transport": map[bool]string{true: "wt", false: "ws"}[o.useWT], "samples": len(s), "meanMs": round(mean), "p50Ms": round(pct(s, 50)),
					"p95Ms": round(pct(s, 95)), "p99Ms": round(pct(s, 99)), "jitterMs": round(a.jit[k][0] / max(1, a.jit[k][1])), "lossPct": round(100 * float64(a.lost[k]) / float64(max(1, a.sent[k])))})
			}
		}
	}
}

// jitter: mean |difference| between consecutive pings of one round (the definition /api/infra/report uses).
func jitter(s []float64) float64 {
	if len(s) < 2 {
		return 0
	}
	var j float64
	for i := 1; i < len(s); i++ {
		j += math.Abs(s[i] - s[i-1])
	}
	return j / float64(len(s)-1)
}

func round(v float64) float64 { return math.Round(v*10) / 10 }
