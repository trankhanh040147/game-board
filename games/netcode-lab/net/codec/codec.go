// Package codec is the binary hot-path wire format (B.5): little-endian,
// every datagram starts with a Fiedler-style ack header.
package codec

import (
	"encoding/binary"
	"errors"
	"math"

	"netcodelab/sim"
)

// Message types (first header byte).
const (
	TInput       uint8 = 1 // C->S
	TSnapshot    uint8 = 2 // S->C
	TSnapshotAck uint8 = 3 // C->S
	TPing        uint8 = 4 // C->S
	TPong        uint8 = 5 // S->C
	TDebug       uint8 = 6 // S->C, truth overlay only
	TClaim       uint8 = 7 // C->S, trust mode / modded client
)

const HeaderSize = 9

// LeadNone in OwnState.InputLead means no input arrived since the previous snapshot.
const LeadNone int8 = 127

// MaxCmds is the current input plus up to 3 redundant unacked inputs (B.4 rule 4).
const MaxCmds = 4

var ErrShort = errors.New("codec: packet too short")
var ErrType = errors.New("codec: unknown message type")

// Header is u8 type, u16 seq, u16 ack, u32 ackBits.
type Header struct {
	Type    uint8
	Seq     uint16
	Ack     uint16
	AckBits uint32
}

// Writer appends little-endian values to a reusable buffer.
type Writer struct{ B []byte }

func (w *Writer) U8(v uint8)    { w.B = append(w.B, v) }
func (w *Writer) U16(v uint16)  { w.B = binary.LittleEndian.AppendUint16(w.B, v) }
func (w *Writer) U32(v uint32)  { w.B = binary.LittleEndian.AppendUint32(w.B, v) }
func (w *Writer) I16(v int16)   { w.U16(uint16(v)) }
func (w *Writer) I32(v int32)   { w.U32(uint32(v)) }
func (w *Writer) F64(v float64) { w.B = binary.LittleEndian.AppendUint64(w.B, math.Float64bits(v)) }
func (w *Writer) Header(h Header) {
	w.U8(h.Type)
	w.U16(h.Seq)
	w.U16(h.Ack)
	w.U32(h.AckBits)
}

// Reader reads little-endian values; the first overrun sets Err.
type Reader struct {
	B   []byte
	Off int
	Err error
}

func (r *Reader) need(n int) bool {
	if r.Err != nil {
		return false // keep the first error
	}
	if r.Off+n > len(r.B) {
		r.Err = ErrShort
		return false
	}
	return true
}
func (r *Reader) U8() uint8 {
	if !r.need(1) {
		return 0
	}
	r.Off++
	return r.B[r.Off-1]
}
func (r *Reader) U16() uint16 {
	if !r.need(2) {
		return 0
	}
	r.Off += 2
	return binary.LittleEndian.Uint16(r.B[r.Off-2:])
}
func (r *Reader) U32() uint32 {
	if !r.need(4) {
		return 0
	}
	r.Off += 4
	return binary.LittleEndian.Uint32(r.B[r.Off-4:])
}
func (r *Reader) I16() int16 { return int16(r.U16()) }
func (r *Reader) I32() int32 { return int32(r.U32()) }
func (r *Reader) F64() float64 {
	if !r.need(8) {
		return 0
	}
	r.Off += 8
	return math.Float64frombits(binary.LittleEndian.Uint64(r.B[r.Off-8:]))
}
func (r *Reader) Header() Header {
	return Header{Type: r.U8(), Seq: r.U16(), Ack: r.U16(), AckBits: r.U32()}
}

// PeekHeader decodes only the header.
func PeekHeader(b []byte) (Header, error) {
	r := Reader{B: b}
	h := r.Header()
	return h, r.Err
}

// ---- Input (C->S) ----

// Input carries up to MaxCmds commands, oldest first.
type Input struct {
	Cmds []sim.Cmd
}

func AppendInput(w *Writer, h Header, in *Input) {
	h.Type = TInput
	w.Header(h)
	n := min(len(in.Cmds), MaxCmds)
	cmds := in.Cmds[len(in.Cmds)-n:]
	w.U8(uint8(n))
	for _, c := range cmds {
		w.U32(c.Seq)
		w.U32(c.ClientTick)
		w.U16(c.In.Buttons)
		w.I16(c.In.Yaw)
		w.I16(c.In.Pitch)
		if c.In.Buttons&sim.BtnFire != 0 {
			w.U32(c.RenderTick)
			w.U16(c.RenderFrac)
			w.U16(c.SubtickFrac)
		}
	}
}

func ReadInput(r *Reader, in *Input) {
	n := int(r.U8())
	if n > MaxCmds {
		r.Err = errors.New("codec: too many input commands")
		return
	}
	in.Cmds = in.Cmds[:0]
	for i := 0; i < n && r.Err == nil; i++ {
		var c sim.Cmd
		c.Seq = r.U32()
		c.ClientTick = r.U32()
		c.In.Buttons = r.U16()
		c.In.Yaw = r.I16()
		c.In.Pitch = r.I16()
		if c.In.Buttons&sim.BtnFire != 0 {
			c.RenderTick = r.U32()
			c.RenderFrac = r.U16()
			c.SubtickFrac = r.U16()
		}
		in.Cmds = append(in.Cmds, c)
	}
}

// ---- Snapshot (S->C) ----

// OwnState is the receiving client's authoritative state plus input-buffer health.
type OwnState struct {
	State       sim.State
	Health      uint8
	InputBuffer uint8  // inputs waiting in the server's buffer for this client
	Starved     uint16 // ticks the server repeated the last input (wraps)
	InputLead   int8   // smallest (clientTick - server tick at arrival) of inputs since the previous snapshot; LeadNone = none arrived
	Dead        bool   // flags bit 0
	Life        uint8  // +1 on every respawn: a teleport, not a misprediction
}

// Entity flags (Entity.Anim).
const (
	AnimOnGround uint8 = 1 << iota
	AnimMoving
	AnimDead
)

type Entity struct {
	ID         uint8
	Team       uint8 // 0 blue, 1 orange
	Pos        [3]int32
	Yaw, Pitch int16
	Health     uint8
	Anim       uint8
}

// Event is an opaque typed payload (hit confirm, kill, damage, rewind debug).
type Event struct {
	Type uint8
	Data []byte
}

type Snapshot struct {
	ServerTick            uint32
	ServerTimeMs          float64
	LastProcessedInputSeq uint32
	Own                   OwnState
	SnapID                uint8 // this snapshot's id (1..255, wraps; 0 = untracked); the client acks it
	BaselineID            uint8 // snapshot the entity list is a delta against (0 = none)
	Encoding              uint8 // EncQuant | EncBitpack | EncDelta (P27); own state is always exact
	Entities              []Entity
	Events                []Event
	// Base is the baseline's entity list, used only when encoding with
	// EncDelta (not on the wire).
	Base []Entity
}

func AppendSnapshot(w *Writer, h Header, s *Snapshot) {
	h.Type = TSnapshot
	w.Header(h)
	w.U32(s.ServerTick)
	w.F64(s.ServerTimeMs)
	w.U32(s.LastProcessedInputSeq)
	appendState(w, &s.Own.State)
	w.U8(s.Own.Health)
	w.U8(s.Own.InputBuffer)
	w.U16(s.Own.Starved)
	w.U8(uint8(s.Own.InputLead))
	var of uint8
	if s.Own.Dead {
		of |= 1
	}
	w.U8(of)
	w.U8(s.Own.Life)
	w.U8(s.SnapID)
	base := s.Base
	if s.Encoding&EncDelta == 0 || s.BaselineID == 0 {
		base = nil
	}
	if base == nil {
		w.U8(0)
	} else {
		w.U8(s.BaselineID)
	}
	appendEntities(w, s.Encoding, s.Entities, base)
	w.U8(uint8(len(s.Events)))
	for _, ev := range s.Events {
		w.U8(ev.Type)
		w.U8(uint8(len(ev.Data)))
		w.B = append(w.B, ev.Data...)
	}
}

// ReadSnapshot decodes a snapshot without baselines: delta-encoded entity
// lists fail with ErrNoBaseline. Clients use ReadSnapshotWith.
func ReadSnapshot(r *Reader, s *Snapshot) { ReadSnapshotWith(r, s, nil) }

// ReadSnapshotWith decodes and, when store is set, resolves delta entity
// lists against it and stores the result under the snapshot's SnapID.
func ReadSnapshotWith(r *Reader, s *Snapshot, store *Baselines) {
	s.ServerTick = r.U32()
	s.ServerTimeMs = r.F64()
	s.LastProcessedInputSeq = r.U32()
	readState(r, &s.Own.State)
	s.Own.Health = r.U8()
	s.Own.InputBuffer = r.U8()
	s.Own.Starved = r.U16()
	s.Own.InputLead = int8(r.U8())
	s.Own.Dead = r.U8()&1 != 0
	s.Own.Life = r.U8()
	s.SnapID = r.U8()
	s.BaselineID = r.U8()
	var base []Entity
	have := false
	if store != nil && s.BaselineID != 0 {
		base, have = store.Get(s.BaselineID)
	}
	s.Entities, s.Encoding = readEntities(r, s.Entities, base, have)
	if r.Err == nil && store != nil && s.SnapID != 0 {
		store.Put(s.SnapID, s.Entities)
	}
	m := int(r.U8())
	s.Events = s.Events[:0]
	for i := 0; i < m && r.Err == nil; i++ {
		t := r.U8()
		l := int(r.U8())
		if !r.need(l) {
			return
		}
		s.Events = append(s.Events, Event{Type: t, Data: append([]byte(nil), r.B[r.Off:r.Off+l]...)})
		r.Off += l
	}
}

func appendState(w *Writer, s *sim.State) {
	for i := 0; i < 3; i++ {
		w.I32(s.Pos[i])
	}
	for i := 0; i < 3; i++ {
		w.I32(s.Vel[i])
	}
	var f uint8
	if s.OnGround {
		f = 1
	}
	w.U8(f)
	w.I16(s.Yaw)
	w.I16(s.Pitch)
}

func readState(r *Reader, s *sim.State) {
	for i := 0; i < 3; i++ {
		s.Pos[i] = r.I32()
	}
	for i := 0; i < 3; i++ {
		s.Vel[i] = r.I32()
	}
	s.OnGround = r.U8()&1 != 0
	s.Yaw = r.I16()
	s.Pitch = r.I16()
}

// ---- SnapshotAck (C->S) ----

type SnapshotAck struct {
	BaselineID uint8
	ServerTick uint32
}

func AppendSnapshotAck(w *Writer, h Header, a *SnapshotAck) {
	h.Type = TSnapshotAck
	w.Header(h)
	w.U8(a.BaselineID)
	w.U32(a.ServerTick)
}

func ReadSnapshotAck(r *Reader, a *SnapshotAck) {
	a.BaselineID = r.U8()
	a.ServerTick = r.U32()
}

// ---- Ping / Pong ----

type Ping struct{ ClientSendMs float64 }

func AppendPing(w *Writer, h Header, p *Ping) {
	h.Type = TPing
	w.Header(h)
	w.F64(p.ClientSendMs)
}

func ReadPing(r *Reader, p *Ping) { p.ClientSendMs = r.F64() }

// Pong echoes the client's send time and carries server monotonic times (ms
// since server start) and the tick position at send, for clock sync (B.4 rule 3).
type Pong struct {
	ClientSendMs float64
	ServerRecvMs float64
	ServerSendMs float64
	ServerTick   uint32
	TickFrac     uint16 // fraction of the current tick elapsed at send, /65536
	TickRate     uint16
}

func AppendPong(w *Writer, h Header, p *Pong) {
	h.Type = TPong
	w.Header(h)
	w.F64(p.ClientSendMs)
	w.F64(p.ServerRecvMs)
	w.F64(p.ServerSendMs)
	w.U32(p.ServerTick)
	w.U16(p.TickFrac)
	w.U16(p.TickRate)
}

func ReadPong(r *Reader, p *Pong) {
	p.ClientSendMs = r.F64()
	p.ServerRecvMs = r.F64()
	p.ServerSendMs = r.F64()
	p.ServerTick = r.U32()
	p.TickFrac = r.U16()
	p.TickRate = r.U16()
}

// ---- Debug feed (S->C) ----

type DebugPos struct {
	ID  uint8
	Pos [3]int32
}

type Debug struct {
	ServerTick uint32
	Players    []DebugPos
}

func AppendDebug(w *Writer, h Header, d *Debug) {
	h.Type = TDebug
	w.Header(h)
	w.U32(d.ServerTick)
	w.U8(uint8(len(d.Players)))
	for _, p := range d.Players {
		w.U8(p.ID)
		w.I32(p.Pos[0])
		w.I32(p.Pos[1])
		w.I32(p.Pos[2])
	}
}

func ReadDebug(r *Reader, d *Debug) {
	d.ServerTick = r.U32()
	n := int(r.U8())
	d.Players = d.Players[:0]
	for i := 0; i < n && r.Err == nil; i++ {
		d.Players = append(d.Players, DebugPos{ID: r.U8(), Pos: [3]int32{r.I32(), r.I32(), r.I32()}})
	}
}
