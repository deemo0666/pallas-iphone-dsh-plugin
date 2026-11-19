// pallas-mesh-node puts this computer's pairing gateway on the Pallas mesh.
//
// It runs Tailscale in userspace (tsnet), so it never touches the computer's own VPN or a
// Tailscale app already installed. Connections to <mesh ip>:<port> are passed to --forward,
// the gateway's loopback listener; the gateway keeps doing all authentication.
//
// Talks to its parent over stdio, one JSON object per line:
//
//	out {"event":"up","ip":"100.64.0.1"}            joined (again after every change)
//	out {"event":"error","error":"..."}
//	in  {"id":"1","op":"invite"}                    a single-use key for a phone
//	out {"id":"1","controlURL":"…","authKey":"…"}   or {"id":"1","error":"…"}
//	in  {"id":"2","op":"probe","addr":"100.64.0.3:62078"}  diagnostics: dial over the mesh
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"tailscale.com/tsnet"
)

var (
	dir      = flag.String("dir", "", "state directory")
	broker   = flag.String("broker", "", "Pallas mesh broker URL")
	forward  = flag.String("forward", "", "host:port connections are passed to")
	port     = flag.Int("port", 42484, "port to answer on the mesh")
	hostname = flag.String("hostname", "", "name on the mesh")
	outMu    sync.Mutex
)

func emit(v any) {
	outMu.Lock()
	defer outMu.Unlock()
	b, _ := json.Marshal(v)
	os.Stdout.Write(append(b, '\n'))
}

func main() {
	flag.Parse()
	if *dir == "" || *broker == "" || *forward == "" {
		log.Fatal("--dir, --broker and --forward are required")
	}
	os.MkdirAll(*dir, 0o700)
	lf, _ := os.OpenFile(filepath.Join(*dir, "node.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	logger := log.New(lf, "", log.LstdFlags)

	key, err := identity()
	if err != nil {
		emit(map[string]string{"event": "error", "error": err.Error()})
		os.Exit(1)
	}
	srv := &tsnet.Server{
		Dir:      filepath.Join(*dir, "tsnet"),
		Hostname: *hostname,
		Logf:     logger.Printf,
		UserLogf: logger.Printf,
	}
	// First run, or the control server changed: ask the broker for a key and the control URL.
	cfg := loadConfig()
	if cfg.ControlURL == "" || !hasState(srv.Dir) {
		res, err := mint(key, "computer")
		if err != nil {
			emit(map[string]string{"event": "error", "error": err.Error()})
			os.Exit(1)
		}
		cfg.ControlURL = res.ControlURL
		saveConfig(cfg)
		srv.AuthKey = res.AuthKey
	}
	srv.ControlURL = cfg.ControlURL

	ctx := context.Background()
	if _, err := srv.Up(ctx); err != nil {
		emit(map[string]string{"event": "error", "error": err.Error()})
		os.Exit(1)
	}
	ln, err := srv.Listen("tcp", ":"+strconv.Itoa(*port))
	if err != nil {
		emit(map[string]string{"event": "error", "error": err.Error()})
		os.Exit(1)
	}
	go serve(ln)
	go watch(ctx, srv)
	commands(key, srv)
	srv.Close()
}

func serve(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go func() {
			defer c.Close()
			up, err := net.DialTimeout("tcp", *forward, 5*time.Second)
			if err != nil {
				return
			}
			defer up.Close()
			go io.Copy(up, c)
			io.Copy(c, up)
		}()
	}
}

// watch reports the mesh address whenever it appears or changes.
func watch(ctx context.Context, srv *tsnet.Server) {
	lc, err := srv.LocalClient()
	if err != nil {
		return
	}
	last := ""
	for {
		if st, err := lc.StatusWithoutPeers(ctx); err == nil && st.Self != nil {
			for _, a := range st.Self.TailscaleIPs {
				if ip := a.String(); a.Is4() && ip != last {
					last = ip
					emit(map[string]string{"event": "up", "ip": ip})
				}
			}
		}
		time.Sleep(5 * time.Second)
	}
}

func commands(key ed25519.PrivateKey, srv *tsnet.Server) {
	in := bufio.NewScanner(os.Stdin)
	for in.Scan() {
		var cmd struct{ ID, Op, Addr string }
		if json.Unmarshal(in.Bytes(), &cmd) != nil {
			continue
		}
		go func() {
			switch cmd.Op {
			case "invite":
				res, err := mint(key, "device")
				if err != nil {
					emit(map[string]string{"id": cmd.ID, "error": err.Error()})
					return
				}
				emit(map[string]string{"id": cmd.ID, "controlURL": res.ControlURL, "authKey": res.AuthKey})
			case "probe":
				// Diagnostics: can this computer reach addr (host:port) over the mesh?
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				c, err := srv.Dial(ctx, "tcp", cmd.Addr)
				if err != nil {
					emit(map[string]string{"id": cmd.ID, "error": err.Error()})
					return
				}
				c.Close()
				emit(map[string]string{"id": cmd.ID, "ok": "true"})
			default:
				emit(map[string]string{"id": cmd.ID, "error": "unknown op"})
			}
		}()
	}
}

type minted struct {
	ControlURL string `json:"controlURL"`
	AuthKey    string `json:"authKey"`
	Error      string `json:"error"`
}

func mint(key ed25519.PrivateKey, purpose string) (minted, error) {
	pub := base64.StdEncoding.EncodeToString(key.Public().(ed25519.PublicKey))
	ts := time.Now().Unix()
	msg := "pallas-mesh|" + pub + "|" + strconv.FormatInt(ts, 10) + "|" + purpose
	body, _ := json.Marshal(map[string]any{
		"pub": pub, "ts": ts, "purpose": purpose,
		"sig": base64.StdEncoding.EncodeToString(ed25519.Sign(key, []byte(msg))),
	})
	c := &http.Client{Timeout: 20 * time.Second}
	resp, err := c.Post(*broker+"/v1/key", "application/json", bytes.NewReader(body))
	if err != nil {
		return minted{}, err
	}
	defer resp.Body.Close()
	var out minted
	json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&out)
	if resp.StatusCode != 200 || out.AuthKey == "" {
		if out.Error == "" {
			out.Error = resp.Status
		}
		return minted{}, fmt.Errorf("broker: %s", out.Error)
	}
	return out, nil
}

func identity() (ed25519.PrivateKey, error) {
	path := filepath.Join(*dir, "identity.key")
	if b, err := os.ReadFile(path); err == nil && len(b) == ed25519.PrivateKeySize {
		return ed25519.PrivateKey(b), nil
	}
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, priv, 0o600); err != nil {
		return nil, errors.New("cannot save identity: " + err.Error())
	}
	return priv, nil
}

type config struct {
	ControlURL string `json:"controlURL"`
}

func loadConfig() (c config) {
	b, _ := os.ReadFile(filepath.Join(*dir, "config.json"))
	json.Unmarshal(b, &c)
	return
}

func saveConfig(c config) {
	b, _ := json.Marshal(c)
	os.WriteFile(filepath.Join(*dir, "config.json"), b, 0o600)
}

func hasState(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, "tailscaled.state"))
	return err == nil
}
