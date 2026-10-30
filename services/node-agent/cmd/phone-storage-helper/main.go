// phone-storage-helper is a local, kernel-quota adapter for an already unlocked
// approved pool. It cannot format/unlock a disk or launch a guest. Optional
// elastic growth uses only the root-installed pool/key paths, never caller paths.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"teamaibox.local/node-agent/internal/phonepool"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "phone_storage_helper_failed: %v\n", err)
		os.Exit(1)
	}
}
func run() error {
	config := flag.String("config", "", "root-owned installed config")
	socket := flag.String("socket", "", "private Unix socket")
	stdio := flag.Bool("stdio", false, "execute one maintenance request")
	flag.Parse()
	s, err := os.Lstat(*config)
	if err != nil || !s.Mode().IsRegular() || s.Mode().Perm()&0022 != 0 || s.Size() > 4096 {
		return fmt.Errorf("invalid config")
	}
	owner, ok := s.Sys().(*syscall.Stat_t)
	if !ok || owner.Uid != 0 {
		return fmt.Errorf("config not root-owned")
	}
	raw, err := os.ReadFile(*config)
	if err != nil {
		return err
	}
	var c phonepool.Config
	if json.Unmarshal(raw, &c) != nil {
		return fmt.Errorf("invalid config")
	}
	p, err := phonepool.New(c)
	if err != nil {
		return err
	}
	defer p.Close()
	if *stdio {
		raw, err = io.ReadAll(io.LimitReader(os.Stdin, 2049))
		if err != nil {
			return err
		}
		q, err := phonepool.DecodeRequest(raw)
		if err != nil {
			return err
		}
		out, err := p.Handle(q)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(out)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	return phonepool.Serve(ctx, p, *socket)
}
