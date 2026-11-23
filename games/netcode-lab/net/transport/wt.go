package transport

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net/http"
	"sync"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/webtransport-go"
)

// WebTransport connection: datagrams are QUIC datagrams (unreliable,
// unordered); control is the first bidirectional stream the client opens,
// carrying newline-delimited JSON.
type wtConn struct {
	s      *webtransport.Session
	str    *webtransport.Stream
	wmu    sync.Mutex
	msgs   chan Msg
	errc   chan error
	cancel context.CancelFunc
}

func (w *wtConn) Kind() Kind                  { return KindWT }
func (w *wtConn) RemoteAddr() string          { return w.s.RemoteAddr().String() }
func (w *wtConn) SendDatagram(b []byte) error { return w.s.SendDatagram(b) }

func (w *wtConn) SendControl(b []byte) error {
	w.wmu.Lock()
	defer w.wmu.Unlock()
	if _, err := w.str.Write(append(append([]byte(nil), b...), '\n')); err != nil {
		return err
	}
	return nil
}

func (w *wtConn) Recv(ctx context.Context) (Msg, error) {
	select {
	case m := <-w.msgs:
		return m, nil
	case err := <-w.errc:
		return Msg{}, err
	case <-ctx.Done():
		return Msg{}, ctx.Err()
	}
}

func (w *wtConn) Close(reason string) error {
	w.cancel()
	return w.s.CloseWithError(0, reason)
}

func newWTConn(s *webtransport.Session, str *webtransport.Stream) *wtConn {
	ctx, cancel := context.WithCancel(s.Context())
	w := &wtConn{s: s, str: str, msgs: make(chan Msg, 256), errc: make(chan error, 2), cancel: cancel}
	fail := func(err error) {
		select {
		case w.errc <- err:
		default:
		}
	}
	go func() {
		for {
			b, err := s.ReceiveDatagram(ctx)
			if err != nil {
				fail(err)
				return
			}
			select {
			case w.msgs <- Msg{Data: b}:
			default: // receiver is behind: drop, like a full socket buffer
			}
		}
	}()
	go func() {
		sc := bufio.NewScanner(str)
		sc.Buffer(make([]byte, 64<<10), 64<<10)
		for sc.Scan() {
			b := append([]byte(nil), sc.Bytes()...)
			select {
			case w.msgs <- Msg{Control: true, Data: b}:
			case <-ctx.Done():
				return
			}
		}
		if err := sc.Err(); err != nil {
			fail(err)
		} else {
			fail(ErrClosed)
		}
	}()
	return w
}

// WTHandler upgrades a request on the HTTP/3 server to a WebTransport session,
// waits for the client's control stream and calls onConn.
func WTHandler(srv *webtransport.Server, onConn func(Conn)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s, err := srv.Upgrade(w, r)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		str, err := s.AcceptStream(s.Context())
		if err != nil {
			s.CloseWithError(1, "no control stream")
			return
		}
		onConn(newWTConn(s, str))
	})
}

// DialWT opens a WebTransport session for a headless client and its control
// stream. The server certificate is pinned by SHA-256 (like the browser's
// serverCertificateHashes); it is self-signed, so the chain is not checked.
func DialWT(ctx context.Context, url string, certSHA256 []byte) (Conn, error) {
	tr := &webtransport.Transport{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true, // replaced by the hash pin below
			VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
				if len(raw) == 0 {
					return errors.New("no certificate")
				}
				sum := sha256.Sum256(raw[0])
				if !bytes.Equal(sum[:], certSHA256) {
					return errors.New("certificate hash mismatch")
				}
				return nil
			},
		},
		QUICConfig: &quic.Config{EnableDatagrams: true, EnableStreamResetPartialDelivery: true},
	}
	_, s, err := tr.Dial(ctx, url, nil)
	if err != nil {
		return nil, err
	}
	str, err := s.OpenStreamSync(ctx)
	if err != nil {
		s.CloseWithError(1, "no control stream")
		return nil, err
	}
	return newWTConn(s, str), nil
}
