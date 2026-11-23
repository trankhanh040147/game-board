package transport

import (
	"context"
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

func (w *wsConn) Recv(ctx context.Context) (Msg, error) {
	typ, data, err := w.c.Read(ctx)
	if err != nil {
		return Msg{}, err
	}
	return Msg{Control: typ == websocket.MessageText, Data: data}, nil
}

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
