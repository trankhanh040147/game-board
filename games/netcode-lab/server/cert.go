package server

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"math/big"
	"net"
	"time"
)

// Cert is the self-signed certificate minted at start. Browsers accept it for
// WebTransport through serverCertificateHashes only if it is ECDSA and valid
// for at most 14 days (B.2 note); the page over HTTPS needs one click-through.
type Cert struct {
	TLS      tls.Certificate
	SHA256   [32]byte
	NotAfter time.Time
	IPs      []net.IP
	HashB64  string
	HashHex  string
	DNSNames []string
}

func LocalIPs() []net.IP {
	ips := []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback}
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && !n.IP.IsLoopback() && !n.IP.IsLinkLocalUnicast() {
			ips = append(ips, n.IP)
		}
	}
	return ips
}

func MintCert() (*Cert, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	ips := LocalIPs()
	tmpl := x509.Certificate{
		SerialNumber:          big.NewInt(now.UnixNano()),
		Subject:               pkix.Name{CommonName: "netcode-lab"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(10 * 24 * time.Hour), // < 14 days incl. the hour of backdating
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{"localhost"},
		IPAddresses:           ips,
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(der)
	return &Cert{
		TLS:      tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key},
		SHA256:   sum,
		NotAfter: tmpl.NotAfter,
		IPs:      ips,
		HashB64:  base64.StdEncoding.EncodeToString(sum[:]),
		HashHex:  hex.EncodeToString(sum[:]),
		DNSNames: tmpl.DNSNames,
	}, nil
}
