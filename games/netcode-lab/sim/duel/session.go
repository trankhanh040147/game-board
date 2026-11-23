package duel

import (
	"encoding/binary"
	"errors"
	"math"
	"slices"
)

// Mode picks how a peer handles the opponent's late inputs (A.13).
type Mode uint8

const (
	// ModeRollback runs the local input now, predicts the opponent as
	// "repeat last", and on a late input that differs loads a saved state and
	// re-simulates to the present.
	ModeRollback Mode = 0
	// ModeLockstep advances a frame only when both inputs for it are here.
	// The input delay D is its playout buffer.
	ModeLockstep Mode = 1
)

const (
	RingN       = 600 // saved states and inputs: 10 s at 60 Hz
	MaxRollback = 8   // frames a peer may predict ahead of the opponent's confirmed input
	FrameMs     = 1000.0 / Hz
	maxSendIn   = 128
	maxSendCk   = 32
	pktType     = 0xD1
	pktMin      = 51 // 41-byte header + empty input block (5) + empty checksum block (5)
	// MaxDelay caps D. Local inputs sit at most D+1 frames ahead of the current
	// frame, so any D below RingN-MaxRollback keeps the input ring from
	// overwriting a frame that may still be re-simulated, however long a stall lasts.
	MaxDelay = 60
)

// AutoDelay is A.13's input delay by ping: 0 below 100 ms, 1 for 100–199, 2 from 200.
func AutoDelay(rttMs float64) int {
	switch {
	case rttMs < 100:
		return 0
	case rttMs < 200:
		return 1
	}
	return 2
}

// LockstepAutoDelay sizes the lockstep playout buffer: the one-way trip in
// frames, rounded up, plus one frame of slack for jitter.
func LockstepAutoDelay(rttMs float64) int {
	return int(math.Ceil(rttMs/2/FrameMs)) + 1
}

// Config of one peer. Delay < 0 means auto (chosen from the ping at Begin).
type Config struct {
	Side  int // 0 or 1
	Delay int
	Mode  Mode
	Epoch uint16
	Seed  uint64
}

// Desync is the first frame whose checksums differ (A.14).
type Desync struct {
	Frame  int32
	Local  uint64
	Remote uint64
}

// Stats are cumulative counters plus 1 s rates.
type Stats struct {
	Frame            int32
	Delay            int
	DelayAuto        bool
	Rollbacks        uint64
	FramesRolledBack uint64
	MaxDepth         int32
	LastDepth        int32
	LastRollbackAt   int32 // frame of the last rollback
	Predicted        int32 // frames run on a predicted opponent input right now
	StallFrames      uint64
	StallMs          float64
	SyncWaits        uint64 // frames skipped to stay level with the peer (time sync)
	ChecksCompared   uint64
	RemoteChanges    uint64 // opponent input changes received (what forces rollbacks)
	PacketsIn        uint64
	PacketsOut       uint64
	RTTMs            float64 // median of the last 32 peer round trips (through the relay)
	JitterMs         float64
	RTTSamples       int
	// Rates over the last full second of wall time.
	RollbacksPerSec   float64
	RolledBackPerSec  float64
	StallFramesPerSec float64
	StallMsPerSec     float64
	Seed              uint64 // this peer's Config.Seed: with it the P25 flip (frame offset, bit, fighter) is reproducible
	InjectedAt        int32  // -1 when nothing injected
	InjectedBit       uint8
	InjectedFighter   uint8
}

// Session is one peer of a duel.
type Session struct {
	cfg     Config
	started bool
	st      State
	cur     int32 // next frame to simulate; st is the state at its start

	ring      [RingN]State
	hash      [RingN]uint64
	hashFrame [RingN]int32
	local     [RingN]uint8
	localN    int32 // local inputs known for frames < localN
	remote    [RingN]uint8
	remoteN   int32 // opponent inputs confirmed for frames < remoteN
	used      [RingN]uint8
	lastRem   uint8
	rbFrom    int32

	peerAck      int32 // peer has our inputs for frames < peerAck
	peerCheckAck int32 // peer has our checksums for frames < peerCheckAck
	rck          [RingN]uint64
	rckFrame     [RingN]int32
	rckN         int32 // contiguous opponent checksums received for frames < rckN
	checkedN     int32 // frames < checkedN compared
	desync       *Desync

	remoteCur int32
	remoteAdv int32
	syncWait  int32

	peerSendMs, peerRecvAt float64
	rtts                   []float64

	stalling   bool
	stallStart float64

	injectAt  int32
	injectBit uint8
	injectF   uint8
	rng       uint64

	win struct {
		at              float64
		rb, rbf, stallF uint64
		stallMs         float64
	}
	stats Stats
}

// NewSession creates a peer. Call Begin once the ping is known (or at once with a fixed delay).
func NewSession(cfg Config) *Session {
	s := &Session{cfg: cfg, st: New(), rbFrom: -1, injectAt: -1, rng: cfg.Seed | 1}
	for i := range s.hashFrame {
		s.hashFrame[i], s.rckFrame[i] = -1, -1
	}
	s.stats.InjectedAt = -1
	return s
}

func (s *Session) Started() bool   { return s.started }
func (s *Session) Config() Config  { return s.cfg }
func (s *Session) State() State    { return s.st }
func (s *Session) Desync() *Desync { return s.desync }

// Begin fixes the input delay (auto from the current ping if Delay < 0) and starts frame 0.
func (s *Session) Begin() {
	if s.started {
		return
	}
	auto := s.cfg.Delay < 0
	if auto {
		if s.cfg.Mode == ModeLockstep {
			s.cfg.Delay = LockstepAutoDelay(s.rttMedian())
		} else {
			s.cfg.Delay = AutoDelay(s.rttMedian())
		}
	}
	s.cfg.Delay = min(s.cfg.Delay, MaxDelay)
	s.stats.Delay, s.stats.DelayAuto = s.cfg.Delay, auto
	s.localN = int32(s.cfg.Delay) // frames 0..D-1 have no input: neutral
	s.started = true
}

// Inject makes this peer's sim nondeterministic (P25): from a seeded frame a
// few frames ahead, one seeded bit of one fighter's X flips, every time that
// frame is simulated here (also in re-simulation) and never on the peer.
func (s *Session) Inject() {
	s.rng ^= s.rng << 13
	s.rng ^= s.rng >> 7
	s.rng ^= s.rng << 17
	s.injectAt = s.cur + 2 + int32(s.rng%8)
	s.injectBit = uint8(8 + (s.rng>>8)%7) // 1 px .. 64 px
	s.injectF = uint8((s.rng >> 16) % 2)
	s.stats.InjectedAt, s.stats.InjectedBit, s.stats.InjectedFighter = s.injectAt, s.injectBit, s.injectF
}

func (s *Session) stepFrame(f int32) {
	i := f % RingN
	s.ring[i] = s.st
	r := s.lastRem
	if f < s.remoteN {
		r = s.remote[i]
	}
	s.used[i] = r
	var in [2]uint8
	in[s.cfg.Side], in[1-s.cfg.Side] = s.local[i], r
	Step(&s.st, in)
	if f == s.injectAt {
		s.st.F[s.injectF].X ^= 1 << s.injectBit
	}
	s.hash[i], s.hashFrame[i] = s.st.Hash(), f
}

// Tick runs one 60 Hz slot with this slot's local buttons. It returns true
// when a frame was simulated, false when the peer had to wait.
func (s *Session) Tick(buttons uint8, nowMs float64) bool {
	s.rates(nowMs)
	if !s.started {
		return false
	}
	if s.localN <= s.cur+int32(s.cfg.Delay) {
		s.local[s.localN%RingN] = buttons
		s.localN++
	}
	if s.rbFrom >= 0 {
		if s.rbFrom < s.cur {
			depth := s.cur - s.rbFrom
			s.st = s.ring[s.rbFrom%RingN]
			for f := s.rbFrom; f < s.cur; f++ {
				s.stepFrame(f)
			}
			s.stats.Rollbacks++
			s.stats.FramesRolledBack += uint64(depth)
			s.stats.LastDepth, s.stats.LastRollbackAt = depth, s.cur
			s.stats.MaxDepth = max(s.stats.MaxDepth, depth)
		}
		s.rbFrom = -1
	}
	s.compareChecks()

	if s.cfg.Mode == ModeRollback && s.syncWait > 0 {
		s.syncWait--
		s.stats.SyncWaits++
		return false
	}
	ok := s.localN > s.cur
	if s.cfg.Mode == ModeLockstep {
		ok = ok && s.remoteN > s.cur
	} else {
		ok = ok && s.cur-s.remoteN < MaxRollback
	}
	if !ok {
		s.stats.StallFrames++
		if !s.stalling {
			s.stalling, s.stallStart = true, nowMs
		}
		return false
	}
	if s.stalling {
		s.stats.StallMs += nowMs - s.stallStart
		s.stalling = false
	}
	s.stepFrame(s.cur)
	s.cur++
	s.compareChecks()
	if s.cfg.Mode == ModeRollback && s.cur%60 == 0 && s.cur >= 120 && len(s.rtts) > 0 {
		// GGPO-style time sync: if we run ahead of the peer more than it runs
		// ahead of us, wait half the difference (at most 4 frames).
		if d := (s.advantage() - s.remoteAdv) / 2; d >= 1 {
			s.syncWait = min(d, 4)
		}
	}
	return true
}

// advantage: how many frames we are ahead of where the peer should be now.
func (s *Session) advantage() int32 {
	return s.cur - (s.remoteCur + int32(math.Round(s.rttMedian()/2/FrameMs)))
}

func (s *Session) compareChecks() {
	conf := min(s.remoteN, s.cur)
	if s.rbFrom >= 0 {
		conf = min(conf, s.rbFrom)
	}
	for s.checkedN < conf && s.rckFrame[s.checkedN%RingN] == s.checkedN {
		i := s.checkedN % RingN
		if s.hashFrame[i] == s.checkedN {
			s.stats.ChecksCompared++
			if s.hash[i] != s.rck[i] && s.desync == nil {
				s.desync = &Desync{Frame: s.checkedN, Local: s.hash[i], Remote: s.rck[i]}
			}
		}
		s.checkedN++
	}
}

func (s *Session) confirmed() int32 {
	c := min(s.remoteN, s.cur)
	if s.rbFrom >= 0 {
		c = min(c, s.rbFrom)
	}
	return c
}

// Packet builds this slot's datagram: unacked inputs, unacked checksums of
// confirmed frames, frame/advantage for time sync and ping fields.
func (s *Session) Packet(nowMs float64) []byte {
	b := make([]byte, 0, 64)
	b = append(b, pktType)
	b = binary.LittleEndian.AppendUint16(b, s.cfg.Epoch)
	b = binary.LittleEndian.AppendUint32(b, uint32(s.cur))
	b = binary.LittleEndian.AppendUint16(b, uint16(int16(max(-30000, min(30000, s.advantage())))))
	b = binary.LittleEndian.AppendUint32(b, uint32(s.remoteN))
	b = binary.LittleEndian.AppendUint32(b, uint32(s.rckN))
	b = binary.LittleEndian.AppendUint64(b, math.Float64bits(nowMs))
	b = binary.LittleEndian.AppendUint64(b, math.Float64bits(s.peerSendMs))
	hold := 0.0
	if s.peerSendMs != 0 {
		hold = nowMs - s.peerRecvAt
	}
	b = binary.LittleEndian.AppendUint64(b, math.Float64bits(hold))
	from := max(s.peerAck, s.localN-maxSendIn)
	b = binary.LittleEndian.AppendUint32(b, uint32(from))
	b = append(b, byte(s.localN-from))
	for f := from; f < s.localN; f++ {
		b = append(b, s.local[f%RingN])
	}
	conf := s.confirmed()
	cf := max(s.peerCheckAck, conf-maxSendCk, 0)
	var n int32
	for f := cf; f < conf && s.hashFrame[f%RingN] == f; f++ {
		n++
	}
	b = binary.LittleEndian.AppendUint32(b, uint32(cf))
	b = append(b, byte(n))
	for f := cf; f < cf+n; f++ {
		b = binary.LittleEndian.AppendUint64(b, s.hash[f%RingN])
	}
	s.stats.PacketsOut++
	return b
}

var ErrPacket = errors.New("duel: bad packet")

// ErrEpoch marks a packet from an earlier match (dropped).
var ErrEpoch = errors.New("duel: other epoch")

// Receive applies one datagram from the peer.
func (s *Session) Receive(b []byte, nowMs float64) error {
	if len(b) < pktMin || b[0] != pktType {
		return ErrPacket
	}
	le := binary.LittleEndian
	if le.Uint16(b[1:]) != s.cfg.Epoch {
		return ErrEpoch
	}
	s.stats.PacketsIn++
	s.remoteCur = int32(le.Uint32(b[3:]))
	s.remoteAdv = int32(int16(le.Uint16(b[7:])))
	s.peerAck = max(s.peerAck, int32(le.Uint32(b[9:])))
	s.peerCheckAck = max(s.peerCheckAck, int32(le.Uint32(b[13:])))
	send := math.Float64frombits(le.Uint64(b[17:]))
	echo := math.Float64frombits(le.Uint64(b[25:]))
	hold := math.Float64frombits(le.Uint64(b[33:]))
	if send > s.peerSendMs {
		s.peerSendMs, s.peerRecvAt = send, nowMs
	}
	if echo > 0 {
		s.addRTT(nowMs - echo - hold)
	}
	o := 41
	first := int32(le.Uint32(b[o:]))
	n := int32(b[o+4])
	o += 5
	if len(b) < o+int(n)+5 {
		return ErrPacket
	}
	for k := int32(0); k < n; k++ {
		g, v := first+k, b[o+int(k)]
		// Contiguous only, and never more than half the ring ahead of our frame,
		// so a long stall (or a bad peer) cannot overwrite inputs still in use.
		if g != s.remoteN || g >= s.cur+RingN/2 {
			continue
		}
		i := g % RingN
		if g > 0 && s.remote[(g-1)%RingN] != v {
			s.stats.RemoteChanges++
		}
		s.remote[i] = v
		s.remoteN++
		s.lastRem = v
		if g < s.cur && s.used[i] != v && (s.rbFrom < 0 || g < s.rbFrom) {
			s.rbFrom = g
		}
	}
	o += int(n)
	cf := int32(le.Uint32(b[o:]))
	m := int(b[o+4])
	o += 5
	if len(b) < o+m*8 {
		return ErrPacket
	}
	for k := range m {
		f := cf + int32(k)
		if f < s.checkedN {
			continue
		}
		i := f % RingN
		s.rck[i], s.rckFrame[i] = le.Uint64(b[o+k*8:]), f
	}
	for s.rckFrame[s.rckN%RingN] == s.rckN {
		s.rckN++
	}
	return nil
}

func (s *Session) addRTT(v float64) {
	if v < 0 {
		return
	}
	if len(s.rtts) == 32 {
		s.rtts = s.rtts[1:]
	}
	s.rtts = append(s.rtts, v)
}

func (s *Session) rttMedian() float64 {
	if len(s.rtts) == 0 {
		return 0
	}
	c := slices.Clone(s.rtts)
	slices.Sort(c)
	return c[len(c)/2]
}

func (s *Session) rates(now float64) {
	if s.win.at == 0 {
		s.win.at = now
		return
	}
	if dt := now - s.win.at; dt >= 1000 {
		k := 1000 / dt
		s.stats.RollbacksPerSec = float64(s.stats.Rollbacks-s.win.rb) * k
		s.stats.RolledBackPerSec = float64(s.stats.FramesRolledBack-s.win.rbf) * k
		s.stats.StallFramesPerSec = float64(s.stats.StallFrames-s.win.stallF) * k
		s.stats.StallMsPerSec = (s.stats.StallMs - s.win.stallMs) * k
		s.win.at, s.win.rb, s.win.rbf, s.win.stallF, s.win.stallMs = now, s.stats.Rollbacks, s.stats.FramesRolledBack, s.stats.StallFrames, s.stats.StallMs
	}
}

// Stats returns a copy of the counters.
func (s *Session) Stats() Stats {
	st := s.stats
	st.Frame = s.cur
	st.Seed = s.cfg.Seed
	st.Predicted = 0
	if s.cfg.Mode == ModeRollback && s.cur > s.remoteN {
		st.Predicted = s.cur - s.remoteN
	}
	st.RTTMs = s.rttMedian()
	st.RTTSamples = len(s.rtts)
	if len(s.rtts) > 1 {
		var j float64
		for i := 1; i < len(s.rtts); i++ {
			j += math.Abs(s.rtts[i] - s.rtts[i-1])
		}
		st.JitterMs = j / float64(len(s.rtts)-1)
	}
	return st
}
