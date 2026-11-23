// Package transport hides how bytes reach a client. Each connection has an
// unreliable datagram path (the binary hot path) and a reliable control path
// (JSON). WebSocket carries both on one TCP stream; WebTransport carries
// datagrams over QUIC and control on a reliable stream.
package transport

import (
	"context"
	"errors"
)

type Kind string

const (
	KindWS Kind = "ws"
	KindWT Kind = "wt"
)

// Msg is one received message.
type Msg struct {
	Control bool // true: JSON control message; false: binary datagram
	Data    []byte
}

// Conn is one client connection.
type Conn interface {
	Kind() Kind
	RemoteAddr() string
	// SendDatagram sends on the hot path. On WebSocket it is a binary frame (reliable, ordered).
	SendDatagram(b []byte) error
	// SendControl sends one JSON control message reliably.
	SendControl(b []byte) error
	// Recv blocks for the next message.
	Recv(ctx context.Context) (Msg, error)
	Close(reason string) error
}

var ErrClosed = errors.New("transport: closed")
