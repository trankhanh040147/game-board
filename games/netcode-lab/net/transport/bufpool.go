package transport

import "sync"

// Received datagram buffers are pooled (P19): Recv hands out a pooled buffer
// for binary messages, and whoever consumes the datagram returns it with
// PutBuf (the server does it from its uplink conditioner's Release hook).
// A mutex stack, not sync.Pool, because putting a slice into sync.Pool
// allocates.

const bufCap = 2048

var pool struct {
	mu   sync.Mutex
	free [][]byte
}

func getBuf() []byte {
	pool.mu.Lock()
	defer pool.mu.Unlock()
	if n := len(pool.free); n > 0 {
		b := pool.free[n-1]
		pool.free[n-1] = nil
		pool.free = pool.free[:n-1]
		return b[:0]
	}
	return make([]byte, 0, bufCap)
}

// PutBuf returns a datagram buffer from Recv. Buffers of other sizes are ignored.
func PutBuf(b []byte) {
	if cap(b) != bufCap {
		return
	}
	pool.mu.Lock()
	if len(pool.free) < 8192 {
		pool.free = append(pool.free, b)
	}
	pool.mu.Unlock()
}
