package codec

import "errors"

// Entity-list encodings (P27). Flags in Snapshot.Encoding.
const (
	EncQuant   uint8 = 1 << iota // positions to 1/256 m in 16 bits, yaw/pitch to 8 bits
	EncBitpack                   // fields packed to their bit widths instead of whole bytes
	EncDelta                     // only entities that changed since the acked baseline
)

// Quantisation steps. Q16.16 positions: 1/256 m = 256 units.
const (
	qPosShift = 8       // 1/256 m
	qYOffset  = 1 << 16 // y is stored as y + 1 m, so -1..7 m fits unsigned
	qXZMax    = 8191    // ±32 m at 1/256 m
	qYMax     = 2047    // 0..8 m at 1/256 m
)

var ErrNoBaseline = errors.New("codec: delta snapshot without its baseline")

type widths struct{ id, team, x, y, z, yaw, pitch, health, anim, mask uint }

func encWidths(enc uint8) widths {
	q, b := enc&EncQuant != 0, enc&EncBitpack != 0
	switch {
	case q && b:
		return widths{8, 1, 15, 11, 15, 8, 8, 7, 3, 3}
	case q:
		return widths{8, 8, 16, 16, 16, 8, 8, 8, 8, 8}
	case b:
		return widths{8, 1, 32, 32, 32, 16, 16, 7, 3, 3}
	default:
		return widths{8, 8, 32, 32, 32, 16, 16, 8, 8, 8}
	}
}

// wireEnt is an entity as it travels (quantised when EncQuant).
type wireEnt struct {
	id, team     uint8
	x, y, z      int32
	yaw, pitch   int32
	health, anim uint8
}

func toWire(e *Entity, enc uint8) wireEnt {
	w := wireEnt{id: e.ID, team: e.Team, x: e.Pos[0], y: e.Pos[1], z: e.Pos[2], yaw: int32(e.Yaw), pitch: int32(e.Pitch), health: e.Health, anim: e.Anim}
	if enc&EncQuant != 0 {
		clamp := func(v, lo, hi int32) int32 { return max(lo, min(hi, v)) }
		w.x = clamp((e.Pos[0]+128)>>qPosShift, -qXZMax, qXZMax)
		w.z = clamp((e.Pos[2]+128)>>qPosShift, -qXZMax, qXZMax)
		w.y = clamp((e.Pos[1]+qYOffset+128)>>qPosShift, 0, qYMax)
		w.yaw = int32(uint8((int32(e.Yaw) + 128) >> 8))
		w.pitch = int32(uint8((int32(e.Pitch) + 128) >> 8))
	}
	return w
}

func fromWire(w wireEnt, enc uint8) Entity {
	e := Entity{ID: w.id, Team: w.team, Pos: [3]int32{w.x, w.y, w.z}, Yaw: int16(w.yaw), Pitch: int16(w.pitch), Health: w.health, Anim: w.anim}
	if enc&EncQuant != 0 {
		e.Pos = [3]int32{w.x << qPosShift, w.y<<qPosShift - qYOffset, w.z << qPosShift}
		e.Yaw, e.Pitch = int16(uint16(uint8(w.yaw))<<8), int16(uint16(uint8(w.pitch))<<8)
	}
	return e
}

// Delta masks.
const (
	dPos  = 1
	dAng  = 2
	dMisc = 4 // team, health, anim
)

// ---- bit stream ----

type bitWriter struct {
	b    []byte
	acc  uint64
	nacc uint
}

func (w *bitWriter) put(v uint64, n uint) {
	if n == 0 {
		return
	}
	if n < 64 {
		v &= 1<<n - 1
	}
	for n > 0 {
		take := min(n, 64-w.nacc)
		if take > 56 {
			take = 56
		}
		w.acc |= (v & (1<<take - 1)) << w.nacc
		w.nacc += take
		v >>= take
		n -= take
		for w.nacc >= 8 {
			w.b = append(w.b, byte(w.acc))
			w.acc >>= 8
			w.nacc -= 8
		}
	}
}

func (w *bitWriter) flush() []byte {
	if w.nacc > 0 {
		w.b = append(w.b, byte(w.acc))
		w.acc, w.nacc = 0, 0
	}
	return w.b
}

type bitReader struct {
	r    *Reader
	acc  uint64
	nacc uint
}

func (br *bitReader) get(n uint) uint64 {
	var v uint64
	var got uint
	for got < n {
		if br.nacc == 0 {
			br.acc, br.nacc = uint64(br.r.U8()), 8
			if br.r.Err != nil {
				return 0
			}
		}
		take := min(n-got, br.nacc)
		v |= (br.acc & (1<<take - 1)) << got
		br.acc >>= take
		br.nacc -= take
		got += take
	}
	return v
}

func (br *bitReader) signed(n uint) int32 {
	v := br.get(n)
	if n < 64 && v&(1<<(n-1)) != 0 {
		v |= ^uint64(0) << n
	}
	return int32(int64(v))
}

func putEnt(bw *bitWriter, e *wireEnt, w widths, mask uint8) {
	if mask&dMisc != 0 {
		bw.put(uint64(e.team), w.team)
		bw.put(uint64(e.health), w.health)
		bw.put(uint64(e.anim), w.anim)
	}
	if mask&dPos != 0 {
		bw.put(uint64(uint32(e.x)), w.x)
		bw.put(uint64(uint32(e.y)), w.y)
		bw.put(uint64(uint32(e.z)), w.z)
	}
	if mask&dAng != 0 {
		bw.put(uint64(uint32(e.yaw)), w.yaw)
		bw.put(uint64(uint32(e.pitch)), w.pitch)
	}
}

func getEnt(br *bitReader, e *wireEnt, w widths, mask uint8, quant bool) {
	if mask&dMisc != 0 {
		e.team = uint8(br.get(w.team))
		e.health = uint8(br.get(w.health))
		e.anim = uint8(br.get(w.anim))
	}
	if mask&dPos != 0 {
		e.x = br.signed(w.x)
		if quant {
			e.y = int32(br.get(w.y))
		} else {
			e.y = br.signed(w.y)
		}
		e.z = br.signed(w.z)
	}
	if mask&dAng != 0 {
		if quant {
			e.yaw, e.pitch = int32(br.get(w.yaw)), int32(br.get(w.pitch))
		} else {
			e.yaw, e.pitch = br.signed(w.yaw), br.signed(w.pitch)
		}
	}
}

func diffMask(a, b *wireEnt) uint8 {
	var m uint8
	if a.x != b.x || a.y != b.y || a.z != b.z {
		m |= dPos
	}
	if a.yaw != b.yaw || a.pitch != b.pitch {
		m |= dAng
	}
	if a.team != b.team || a.health != b.health || a.anim != b.anim {
		m |= dMisc
	}
	return m
}

// appendEntities writes the entity section: u8 encoding, u8 count, the bit
// stream, and for delta a u8 removed count + ids. base is the baseline's
// entity list (sorted by id) and is used only with EncDelta.
func appendEntities(w *Writer, enc uint8, ents, base []Entity) {
	if enc&EncDelta != 0 && base == nil {
		enc &^= EncDelta
	}
	wd := encWidths(enc)
	w.U8(enc)
	countAt := len(w.B)
	w.U8(0)
	bw := bitWriter{b: w.B}
	n := 0
	bi := 0
	for i := range ents {
		cur := toWire(&ents[i], enc)
		mask := uint8(dPos | dAng | dMisc)
		if enc&EncDelta != 0 {
			for bi < len(base) && base[bi].ID < ents[i].ID {
				bi++
			}
			if bi < len(base) && base[bi].ID == ents[i].ID {
				old := toWire(&base[bi], enc)
				mask = diffMask(&cur, &old)
				if mask == 0 {
					continue
				}
			}
		}
		bw.put(uint64(cur.id), wd.id)
		if enc&EncDelta != 0 {
			bw.put(uint64(mask), wd.mask)
		}
		putEnt(&bw, &cur, wd, mask)
		n++
	}
	w.B = bw.flush()
	w.B[countAt] = uint8(n)
	if enc&EncDelta != 0 {
		remAt := len(w.B)
		w.U8(0)
		removed := 0
		ci := 0
		for _, b := range base {
			for ci < len(ents) && ents[ci].ID < b.ID {
				ci++
			}
			if ci >= len(ents) || ents[ci].ID != b.ID {
				w.U8(b.ID)
				removed++
			}
		}
		w.B[remAt] = uint8(removed)
	}
}

// readEntities reads the entity section into out (reusing its capacity).
func readEntities(r *Reader, out []Entity, base []Entity, haveBase bool) ([]Entity, uint8) {
	enc := r.U8()
	n := int(r.U8())
	wd := encWidths(enc)
	quant := enc&EncQuant != 0
	delta := enc&EncDelta != 0
	if delta && !haveBase {
		r.Err = ErrNoBaseline
		return out[:0], enc
	}
	out = out[:0]
	if delta {
		out = append(out, base...)
	}
	br := bitReader{r: r}
	for i := 0; i < n && r.Err == nil; i++ {
		var we wireEnt
		we.id = uint8(br.get(wd.id))
		mask := uint8(dPos | dAng | dMisc)
		idx := -1
		if delta {
			mask = uint8(br.get(wd.mask))
			for j := range out {
				if out[j].ID == we.id {
					idx = j
					break
				}
			}
			if idx >= 0 {
				we = toWire(&out[idx], enc)
			}
		}
		getEnt(&br, &we, wd, mask, quant)
		e := fromWire(we, enc)
		if idx >= 0 {
			out[idx] = e
		} else {
			out = append(out, e)
		}
	}
	if delta && r.Err == nil {
		rem := int(r.U8())
		for i := 0; i < rem && r.Err == nil; i++ {
			id := r.U8()
			for j := range out {
				if out[j].ID == id {
					out = append(out[:j], out[j+1:]...)
					break
				}
			}
		}
		// keep id order
		for i := 1; i < len(out); i++ {
			for j := i; j > 0 && out[j].ID < out[j-1].ID; j-- {
				out[j], out[j-1] = out[j-1], out[j]
			}
		}
	}
	return out, enc
}

// Baselines keeps the entity lists of recent snapshots by snapId, on the
// decoding side (client) or the encoding side (server: what it sent).
type Baselines struct {
	ids  [256]uint32 // generation per slot (0 = empty)
	ents [256][]Entity
	gen  uint32
}

func (b *Baselines) Put(id uint8, ents []Entity) {
	b.gen++
	b.ids[id] = b.gen
	b.ents[id] = append(b.ents[id][:0], ents...)
}

// Get returns the entity list stored for id, if any.
func (b *Baselines) Get(id uint8) ([]Entity, bool) {
	if id == 0 || b.ids[id] == 0 {
		return nil, false
	}
	return b.ents[id], true
}

// Age is how many Puts ago id was stored.
func (b *Baselines) Age(id uint8) uint32 {
	if b.ids[id] == 0 {
		return ^uint32(0)
	}
	return b.gen - b.ids[id]
}

// EntitySectionSize returns the encoded size of an entity list (P27 meters).
func EntitySectionSize(scratch *Writer, enc uint8, ents, base []Entity) int {
	scratch.B = scratch.B[:0]
	appendEntities(scratch, enc, ents, base)
	return len(scratch.B)
}
