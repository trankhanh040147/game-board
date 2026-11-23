package server

import "sync"

// bufPool recycles datagram buffers for the zero-alloc loop (P19). A mutex
// stack instead of sync.Pool: putting a slice into sync.Pool boxes it, which
// allocates. Only buffers it handed out (cap == poolBufCap) go back.
type bufPool struct {
	mu   sync.Mutex
	free [][]byte
	news uint64 // buffers created (stays flat once warm)
}

const poolBufCap = 2048

func (p *bufPool) get() []byte {
	p.mu.Lock()
	defer p.mu.Unlock()
	if n := len(p.free); n > 0 {
		b := p.free[n-1]
		p.free[n-1] = nil
		p.free = p.free[:n-1]
		return b[:0]
	}
	p.news++
	return make([]byte, 0, poolBufCap)
}

func (p *bufPool) put(b []byte) {
	if cap(b) != poolBufCap {
		return // grew past the size class, or came from the naive loop
	}
	p.mu.Lock()
	if len(p.free) < 4096 {
		p.free = append(p.free, b)
	}
	p.mu.Unlock()
}
