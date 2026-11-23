package sim

// Cmd is one numbered input (A.7): what the client sends, never a result.
type Cmd struct {
	Seq        uint32
	ClientTick uint32
	In         Input
	// Fire timing (B.4 rule 5); meaningful only when In.Buttons&BtnFire != 0.
	RenderTick  uint32
	RenderFrac  uint16
	SubtickFrac uint16
}

type pendingCmd struct {
	cmd   Cmd
	after State // predicted state after applying cmd
}

// Predictor is client-side prediction plus reconciliation (A.6, A.7). The
// browser uses it through WASM and the Go bots use it directly.
type Predictor struct {
	Map    *Map
	Params Params
	State  State

	pending []pendingCmd

	Corrections uint64 // server state differed from what we predicted for that input
	Replayed    uint64 // total inputs replayed on top of server state
}

func NewPredictor(m *Map, s State) *Predictor {
	return &Predictor{Map: m, Params: DefaultParams(), State: s}
}

// Reset sets the predicted state and forgets pending inputs.
func (p *Predictor) Reset(s State) {
	p.State = s
	p.pending = p.pending[:0]
}

// Predict applies cmd locally now and keeps it until the server acks it.
func (p *Predictor) Predict(c Cmd, dt Fx) State {
	Step(p.Map, &p.State, c.In, dt, &p.Params)
	p.pending = append(p.pending, pendingCmd{cmd: c, after: p.State})
	if len(p.pending) > 256 { // the server stopped acking; keep memory bounded
		p.pending = append(p.pending[:0], p.pending[len(p.pending)-256:]...)
	}
	return p.State
}

// Pending returns the unacknowledged commands, oldest first.
func (p *Predictor) Pending() []Cmd {
	out := make([]Cmd, len(p.pending))
	for i, pc := range p.pending {
		out[i] = pc.cmd
	}
	return out
}

// ReconcileResult reports what a server snapshot did to the prediction.
type ReconcileResult struct {
	Corrected bool
	Replayed  int
	// Delta is old predicted position minus new predicted position, for
	// visual smoothing of corrections.
	Delta [3]Fx
}

// Reconcile applies the server's state as of input lastSeq. With replay it
// rebases on the server state and replays the unacked inputs (A.7). Without
// replay it hard-snaps to the server state (the P04 "no reconciliation" view).
func (p *Predictor) Reconcile(server State, lastSeq uint32, dt Fx, replay bool) ReconcileResult {
	var r ReconcileResult
	before := p.State
	drop := 0
	for i, pc := range p.pending {
		if int32(pc.cmd.Seq-lastSeq) > 0 {
			break
		}
		drop = i + 1
		if pc.cmd.Seq == lastSeq && pc.after != server {
			r.Corrected = true
		}
	}
	p.pending = append(p.pending[:0], p.pending[drop:]...)
	if r.Corrected {
		p.Corrections++
	}
	p.State = server
	if replay {
		for i := range p.pending {
			Step(p.Map, &p.State, p.pending[i].cmd.In, dt, &p.Params)
			p.pending[i].after = p.State
		}
		r.Replayed = len(p.pending)
		p.Replayed += uint64(r.Replayed)
	}
	for i := 0; i < 3; i++ {
		r.Delta[i] = before.Pos[i] - p.State.Pos[i]
	}
	return r
}
