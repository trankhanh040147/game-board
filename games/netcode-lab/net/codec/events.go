package codec

// Snapshot event types (Event.Type). Events are resent in every snapshot
// until the client acks a snapshot tick at or after the first one carrying
// them, so clients must dedupe (EvShotResult/EvDamage by ShotSeq+ShooterID,
// EvDeath by Life).
const (
	EvShotResult uint8 = 1 // to the shooter: outcome of one fire input (hit confirm, miss reason, rewind debug, P11 stamps)
	EvDamage     uint8 = 2 // to the victim
	EvDeath      uint8 = 3 // to the victim: data for the death replay (P24)
)

// ShotResult flags.
const (
	ShotLagComp   uint8 = 1 << iota // the server rewound other players
	ShotClamped                     // render time was older than the history cap (or in the future) and was clamped
	ShotFavoured                    // rewind skipped: shooter RTT above favourVictimRttMs
	ShotKilled                      // the hit killed the victim
	ShotTrustMode                   // resolved from a client claim (trust mode)
)

// ShotResult is the server's verdict on one fire input. ShotSeq is the input
// seq of the fire command (the shot id).
type ShotResult struct {
	ShotSeq     uint32
	ResolveTick uint32 // tick whose simulate consumed the fire input
	RenderTick  uint32 // as sent by the client
	RenderFrac  uint16 // as sent by the client
	RewoundTick uint32 // time the other players were placed at (== ResolveTick when not rewound)
	RewoundFrac uint16
	Flags       uint8
	HitID       uint8 // 0 = miss
	Hitbox      uint8 // sim.HitBody / sim.HitHead
	Damage      uint8
	VictimHP    uint8 // victim health after the hit
	SeenID      uint8 // player the ray hits at the client's render time (what the shooter saw), 0 = none
	SeenHitbox  uint8
	MovedCm     uint16   // how far SeenID moved between the render time and the time used
	SeenPos     [3]int32 // SeenID (else HitID) feet position at render time: red box (P09)
	UsedPos     [3]int32 // same player at the time used: blue box (P09)
	WallDistCm  uint32   // distance to the first map box along the ray (tracer end)
	RecvMs      float64  // server time the fire input arrived (after the uplink conditioner)
	TickStartMs float64  // server time the resolving tick started
}

func (e *ShotResult) Append(b []byte) []byte {
	w := Writer{B: b}
	w.U32(e.ShotSeq)
	w.U32(e.ResolveTick)
	w.U32(e.RenderTick)
	w.U16(e.RenderFrac)
	w.U32(e.RewoundTick)
	w.U16(e.RewoundFrac)
	w.U8(e.Flags)
	w.U8(e.HitID)
	w.U8(e.Hitbox)
	w.U8(e.Damage)
	w.U8(e.VictimHP)
	w.U8(e.SeenID)
	w.U8(e.SeenHitbox)
	w.U16(e.MovedCm)
	for i := 0; i < 3; i++ {
		w.I32(e.SeenPos[i])
	}
	for i := 0; i < 3; i++ {
		w.I32(e.UsedPos[i])
	}
	w.U32(e.WallDistCm)
	w.F64(e.RecvMs)
	w.F64(e.TickStartMs)
	return w.B
}

func (e *ShotResult) Read(r *Reader) {
	e.ShotSeq = r.U32()
	e.ResolveTick = r.U32()
	e.RenderTick = r.U32()
	e.RenderFrac = r.U16()
	e.RewoundTick = r.U32()
	e.RewoundFrac = r.U16()
	e.Flags = r.U8()
	e.HitID = r.U8()
	e.Hitbox = r.U8()
	e.Damage = r.U8()
	e.VictimHP = r.U8()
	e.SeenID = r.U8()
	e.SeenHitbox = r.U8()
	e.MovedCm = r.U16()
	for i := 0; i < 3; i++ {
		e.SeenPos[i] = r.I32()
	}
	for i := 0; i < 3; i++ {
		e.UsedPos[i] = r.I32()
	}
	e.WallDistCm = r.U32()
	e.RecvMs = r.F64()
	e.TickStartMs = r.F64()
}

// Damage tells the victim it was hit.
type Damage struct {
	ShotSeq     uint32
	ShooterID   uint8
	Hitbox      uint8
	Damage      uint8
	Health      uint8 // after the hit
	ResolveTick uint32
	Flags       uint8 // ShotResult flags
}

func (e *Damage) Append(b []byte) []byte {
	w := Writer{B: b}
	w.U32(e.ShotSeq)
	w.U8(e.ShooterID)
	w.U8(e.Hitbox)
	w.U8(e.Damage)
	w.U8(e.Health)
	w.U32(e.ResolveTick)
	w.U8(e.Flags)
	return w.B
}

func (e *Damage) Read(r *Reader) {
	e.ShotSeq = r.U32()
	e.ShooterID = r.U8()
	e.Hitbox = r.U8()
	e.Damage = r.U8()
	e.Health = r.U8()
	e.ResolveTick = r.U32()
	e.Flags = r.U8()
}

// Death gives the victim what the server used to kill it (P24 "died behind
// the wall"): where the server placed the victim for the hit (HitPos, possibly
// rewound) versus where the victim really was at that tick (NowPos).
type Death struct {
	Life         uint8 // the life that ended
	ShooterID    uint8
	Hitbox       uint8
	Flags        uint8 // ShotResult flags
	ShotSeq      uint32
	ResolveTick  uint32
	RewoundTick  uint32
	RewoundFrac  uint16
	HitPos       [3]int32
	NowPos       [3]int32
	ShooterPos   [3]int32
	ShooterYaw   int16
	ShooterPitch int16
	RespawnTick  uint32
}

func (e *Death) Append(b []byte) []byte {
	w := Writer{B: b}
	w.U8(e.Life)
	w.U8(e.ShooterID)
	w.U8(e.Hitbox)
	w.U8(e.Flags)
	w.U32(e.ShotSeq)
	w.U32(e.ResolveTick)
	w.U32(e.RewoundTick)
	w.U16(e.RewoundFrac)
	for _, p := range [][3]int32{e.HitPos, e.NowPos, e.ShooterPos} {
		w.I32(p[0])
		w.I32(p[1])
		w.I32(p[2])
	}
	w.I16(e.ShooterYaw)
	w.I16(e.ShooterPitch)
	w.U32(e.RespawnTick)
	return w.B
}

func (e *Death) Read(r *Reader) {
	e.Life = r.U8()
	e.ShooterID = r.U8()
	e.Hitbox = r.U8()
	e.Flags = r.U8()
	e.ShotSeq = r.U32()
	e.ResolveTick = r.U32()
	e.RewoundTick = r.U32()
	e.RewoundFrac = r.U16()
	for _, p := range []*[3]int32{&e.HitPos, &e.NowPos, &e.ShooterPos} {
		p[0], p[1], p[2] = r.I32(), r.I32(), r.I32()
	}
	e.ShooterYaw = r.I16()
	e.ShooterPitch = r.I16()
	e.RespawnTick = r.U32()
}

// ---- C->S Claim (type 7): trust mode and the "modded client" ----

// Claim is a client stating a result instead of an input: "I am here" and
// optionally "I hit player V in the head". The server relays it only in trust
// mode (A.5); otherwise it is rejected and logged.
type Claim struct {
	InputSeq   uint32
	ClientTick uint32
	Pos        [3]int32
	VictimID   uint8 // 0 = position only
	Hitbox     uint8
}

func AppendClaim(w *Writer, h Header, c *Claim) {
	h.Type = TClaim
	w.Header(h)
	w.U32(c.InputSeq)
	w.U32(c.ClientTick)
	w.I32(c.Pos[0])
	w.I32(c.Pos[1])
	w.I32(c.Pos[2])
	w.U8(c.VictimID)
	w.U8(c.Hitbox)
}

func ReadClaim(r *Reader, c *Claim) {
	c.InputSeq = r.U32()
	c.ClientTick = r.U32()
	c.Pos = [3]int32{r.I32(), r.I32(), r.I32()}
	c.VictimID = r.U8()
	c.Hitbox = r.U8()
}
