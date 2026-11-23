package transport

import (
	"context"
	"io"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

type wsConn struct {
	c      *websocket.Conn
	remote string
}

func (w *wsConn) Kind() Kind         { return KindWS }
func (w *wsConn) RemoteAddr() string { return w.remote }

func (w *wsConn) SendDatagram(b []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return w.c.Write(ctx, websocket.MessageBinary, b)
}

func (w *wsConn) SendControl(b []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return w.c.Write(ctx, websocket.MessageText, b)
}

// Recv reads one message. Binary messages come in a pooled buffer (PutBuf
// when done). A context that can never be cancelled is read without the
// per-read timeout goroutine coder/websocket sets up for cancellable ones;
// closing the connection still unblocks the read.
func (w *wsConn) Recv(ctx context.Context) (Msg, error) {
	if ctx.Done() != nil && ctx.Err() != nil {
		return Msg{}, ctx.Err()
	}
	typ, r, err := w.c.Reader(readCtx(ctx))
	if err != nil {
		return Msg{}, err
	}
	if typ == websocket.MessageText {
		data, err := io.ReadAll(r)
		return Msg{Control: true, Data: data}, err
	}
	b := getBuf()
	for {
		if len(b) == cap(b) {
			b = append(b, 0)[:len(b)] // grows past the pool size class: GC'd, not pooled
		}
		n, err := r.Read(b[len(b):cap(b)])
		b = b[:len(b)+n]
		if err == io.EOF {
			return Msg{Data: b}, nil
		}
		if err != nil {
			return Msg{}, err
		}
	}
}

// readCtx drops cancellation the caller does not need per read: the server's
// connection loop ends by closing the connection, which unblocks the read.
func readCtx(ctx context.Context) context.Context {
	if _, ok := ctx.(noCancel); ok {
		return context.Background()
	}
	return ctx
}

// noCancel marks a context whose cancellation only happens through Close.
type noCancel struct{ context.Context }

// NoCancel wraps ctx for Recv loops that stop by closing the connection.
func NoCancel(ctx context.Context) context.Context { return noCancel{ctx} }

func (w *wsConn) Close(reason string) error {
	return w.c.Close(websocket.StatusNormalClosure, reason)
}

// WSHandler upgrades HTTP requests to WebSocket connections and calls onConn
// for each one in the request goroutine. Binary frames are datagrams, text
// frames are control JSON.
//
// Origins: the page may come from the Go server itself, from the Vite dev
// server (localhost:5173) or from a LAN IP, so any origin is accepted. This is
// a LAN teaching demo with no accounts; Lab changes still need the admin token.
func WSHandler(onConn func(Conn)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			InsecureSkipVerify: true, // explicit origin check: accept all (see above)
			CompressionMode:    websocket.CompressionDisabled,
		})
		if err != nil {
			return
		}
		c.SetReadLimit(1 << 16)
		onConn(&wsConn{c: c, remote: r.RemoteAddr})
	})
}

// DialWS connects a headless client (bot) to a WebSocket URL.
func DialWS(ctx context.Context, url string) (Conn, error) {
	c, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return nil, err
	}
	c.SetReadLimit(1 << 16)
	return &wsConn{c: c, remote: url}, nil
}
