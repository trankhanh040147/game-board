// Command relay is a tiny UDP datagram relay (A.12 "private backbone /
// relays", P18). Each client address gets its own upstream socket; datagrams
// in both directions go through the in-process conditioner with a SIMULATED
// profile: "public" (crossing public ISP hops: high jitter and loss) or
// "backbone" (a private network: low jitter, no loss).
//
//	relay -listen :18750 -to 127.0.0.1:9000 -profile backbone
package main

import (
	"flag"
	"log/slog"
	"net"
	"os"
	"sync"
	"time"

	"netcodelab/net/cond"
)

var profiles = map[string]cond.Params{
	"public":   {DelayMs: 8, JitterMs: 10, LossPct: 1},
	"backbone": {DelayMs: 3, JitterMs: 0.5, LossPct: 0},
	"none":     {},
}

type peer struct {
	up, down *cond.Link
	conn     *net.UDPConn
	last     time.Time
}

func main() {
	listen := flag.String("listen", "0.0.0.0:18750", "UDP address clients send to")
	to := flag.String("to", "127.0.0.1:9000", "UDP server address")
	prof := flag.String("profile", "backbone", "public, backbone or none (simulated, per direction)")
	flag.Parse()
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	p, ok := profiles[*prof]
	if !ok {
		log.Error("unknown profile", "profile", *prof)
		os.Exit(2)
	}
	la, err := net.ResolveUDPAddr("udp", *listen)
	if err != nil {
		log.Error("listen addr", "err", err)
		os.Exit(2)
	}
	ra, err := net.ResolveUDPAddr("udp", *to)
	if err != nil {
		log.Error("server addr", "err", err)
		os.Exit(2)
	}
	in, err := net.ListenUDP("udp", la)
	if err != nil {
		log.Error("listen", "err", err)
		os.Exit(1)
	}
	log.Info("relay (simulated profile)", "listen", *listen, "to", *to, "profile", *prof, "params", p)
	var mu sync.Mutex
	peers := map[string]*peer{}
	var seed uint64
	buf := make([]byte, 65536)
	for {
		n, from, err := in.ReadFromUDP(buf)
		if err != nil {
			log.Error("read", "err", err)
			os.Exit(1)
		}
		data := append([]byte(nil), buf[:n]...)
		mu.Lock()
		pr := peers[from.String()]
		if pr == nil {
			c, err := net.DialUDP("udp", nil, ra)
			if err != nil {
				mu.Unlock()
				continue
			}
			seed += 2
			client := from
			pr = &peer{conn: c}
			pr.up = cond.NewLink(p, false, seed, func(b []byte) { c.Write(b) })
			pr.down = cond.NewLink(p, false, seed+1, func(b []byte) { in.WriteToUDP(b, client) })
			peers[from.String()] = pr
			go func() {
				rb := make([]byte, 65536)
				for {
					c.SetReadDeadline(time.Now().Add(60 * time.Second))
					n, err := c.Read(rb)
					if err != nil {
						mu.Lock()
						delete(peers, client.String())
						mu.Unlock()
						pr.up.Close()
						pr.down.Close()
						c.Close()
						return
					}
					pr.down.Push(append([]byte(nil), rb[:n]...))
				}
			}()
		}
		pr.last = time.Now()
		mu.Unlock()
		pr.up.Push(data)
	}
}
