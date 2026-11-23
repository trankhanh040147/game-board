package server

import (
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Fill bots (B.1 goal 1, B.2 "Fill teams"): bots' cmd/bot -kind fill joined
// over this server's own WebSocket, so they play through the normal input path
// and the server decides every hit (they never send claims). One child process
// holds all of them; replacing or removing the fill stops it (SIGTERM).
// Their names end in FillTag, which the scoreboard and kill feed show.
const FillTag = " [bot]"

const maxFill = 10

// fills holds each Room's fill state here, so this file needs no field in Room.
var fills sync.Map // *Room -> *fillState

func (r *Room) fillS() *fillState {
	v, _ := fills.LoadOrStore(r, &fillState{})
	return v.(*fillState)
}

type fillState struct {
	mu    sync.Mutex
	bin   string
	wsURL string
	cmd   *exec.Cmd
	n     int
	err   string
}

// SetFillBots enables fill bots: bin is cmd/bot, wsURL this server's WebSocket.
func (r *Room) SetFillBots(bin, wsURL string) {
	f := r.fillS()
	f.mu.Lock()
	f.bin, f.wsURL = bin, wsURL
	f.mu.Unlock()
}

// humansPerTeam counts connected players that are not fill bots (spectators excluded).
func (r *Room) humansPerTeam() (blue, orange int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, c := range r.clients {
		if c.spectator || strings.HasSuffix(c.name, FillTag) {
			continue
		}
		if c.team == 1 {
			orange++
		} else {
			blue++
		}
	}
	return
}

// FillCount turns a request into a bot count: n ≥ 0 is literal; n < 0 means
// "balance": both teams up to max(3, the larger human team).
func (r *Room) FillCount(n int) int {
	if n >= 0 {
		return min(n, maxFill)
	}
	b, o := r.humansPerTeam()
	per := max(3, b, o)
	return min(maxFill, max(0, 2*per-b-o))
}

// SetFill replaces the running fill with n bots (0 removes them all).
func (r *Room) SetFill(n int) (int, error) {
	n = r.FillCount(n)
	f := r.fillS()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.cmd != nil {
		f.cmd.Process.Signal(syscall.SIGTERM)
		done := make(chan struct{})
		go func(c *exec.Cmd) { c.Wait(); close(done) }(f.cmd)
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			f.cmd.Process.Kill()
		}
		f.cmd = nil
	}
	f.n, f.err = 0, ""
	if n == 0 {
		return 0, nil
	}
	if f.bin == "" {
		f.err = "fill bots disabled (server started without -bot)"
		return 0, errStr(f.err)
	}
	cmd := exec.Command(f.bin, "-kind", "fill", "-n", strconv.Itoa(n), "-url", f.wsURL, "-d", "0")
	if err := cmd.Start(); err != nil {
		f.err = err.Error()
		return 0, err
	}
	f.cmd, f.n = cmd, n
	r.log.Info("fill bots", "n", n, "pid", cmd.Process.Pid)
	go func() {
		err := cmd.Wait()
		f.mu.Lock()
		if f.cmd == cmd { // ended on its own (not replaced)
			f.cmd, f.n = nil, 0
			if err != nil {
				f.err = "fill bots exited: " + err.Error()
			}
		}
		f.mu.Unlock()
		r.broadcastFill()
	}()
	return n, nil
}

// StopFill ends the fill process (server shutdown).
func (r *Room) StopFill() { r.SetFill(0) }

func (r *Room) fillMsg() map[string]any {
	f := r.fillS()
	f.mu.Lock()
	defer f.mu.Unlock()
	return map[string]any{"t": "fill", "bots": f.n, "enabled": f.bin != "", "error": f.err, "tag": strings.TrimSpace(FillTag)}
}

func (r *Room) broadcastFill() { r.broadcast(r.fillMsg()) }

// handleFill: {t:"fill", token, n} with n ≥ 0 bots, or n = -1 to balance the teams (admin).
func (r *Room) handleFill(c *Client, token string, n int) {
	if !r.checkToken(token) {
		r.errorTo(c, "fill: admin token required")
		return
	}
	go func() {
		if _, err := r.SetFill(n); err != nil {
			r.errorTo(c, "fill: "+err.Error())
		}
		r.broadcastFill()
	}()
}

type errStr string

func (e errStr) Error() string { return string(e) }
