package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

// Qualification only: a standard adb client in the isolated checker connects
// through the real coordinator/driver's private Unix socket to the new Android.
func probeADBDriver(ctx context.Context, c *agent.PhoneCoordinator, p agent.PhoneCommandPayload, policy agent.PhoneRuntimePolicy, stateRoot string) (map[string]any, error) {
	p.OperationID = p.Run.ReservationID
	media := agent.PhoneMediaPayload{PhoneCommandPayload: p, GrantID: p.OperationID, SessionID: p.OwnerID, Kind: "adb", LeaseExpiresAt: time.Now().Add(4500 * time.Millisecond).UnixMilli()}
	ownership := agent.Ownership{NodeID: policy.NodeID, NodeGeneration: policy.NodeGeneration, LeaseID: p.PhoneID, FencingToken: p.Generation + 1}
	if conn, err := c.OpenPhoneADB(ctx, media); err == nil {
		conn.Close()
		return nil, errors.New("ungranted_adb_opened")
	}
	opened, err := c.ExecutePhoneMedia(ctx, "open", media, ownership)
	if err != nil {
		// Only fixed error identifiers, never socket paths or arbitrary output.
		code := err.Error()
		if len(code) < 100 && strings.HasPrefix(code, "phone_") && !strings.ContainsAny(code, " /:\n\r") {
			return nil, fmt.Errorf("adb_driver_grant_failed:%s", code)
		}
		return nil, errors.New("adb_driver_grant_failed")
	}
	if !opened.PeerOpen {
		return nil, errors.New("adb_driver_grant_failed")
	}
	defer func() {
		media.LeaseExpiresAt = 0
		_, _ = c.ExecutePhoneMedia(context.Background(), "close", media, ownership)
	}()
	wrong := media
	wrong.OwnerID = p.PhoneID
	if conn, err := c.OpenPhoneADB(ctx, wrong); err == nil {
		conn.Close()
		return nil, errors.New("foreign_owner_adb_opened")
	}
	wrong = media
	wrong.Kind = "control"
	if conn, err := c.OpenPhoneADB(ctx, wrong); err == nil {
		conn.Close()
		return nil, errors.New("control_grant_adb_opened")
	}
	upstream, err := c.OpenPhoneADB(ctx, media)
	if err != nil {
		return nil, err
	}
	defer upstream.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	defer listener.Close()
	serial := fmt.Sprintf("127.0.0.1:%d", listener.Addr().(*net.TCPAddr).Port)
	ended := make(chan struct{})
	go func() {
		defer close(ended)
		local, err := listener.Accept()
		if err != nil {
			return
		}
		defer local.Close()
		defer upstream.Close()
		copied := make(chan struct{}, 2)
		go func() { _, _ = io.Copy(upstream, local); copied <- struct{}{} }()
		go func() { _, _ = io.Copy(local, upstream); copied <- struct{}{} }()
		<-copied
		local.Close()
		upstream.Close()
		<-copied
	}()
	home, err := os.MkdirTemp(stateRoot, "adb-client-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(home)
	command := func(args ...string) (string, error) {
		bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		cmd := exec.CommandContext(bounded, "/opt/cuttlefish/bin/adb", append([]string{"-P", "5039"}, args...)...)
		cmd.Env = append(os.Environ(), "HOME="+filepath.Clean(home))
		raw, err := cmd.CombinedOutput()
		if len(raw) > 4096 {
			return "", errors.New("adb_probe_output_invalid")
		}
		if err != nil {
			lower := strings.ToLower(string(raw))
			for _, word := range []string{"unauthorized", "permission denied", "read-only", "offline", "cannot bind", "not found"} {
				if strings.Contains(lower, word) {
					return "", fmt.Errorf("adb_probe_%s", strings.ReplaceAll(word, " ", "_"))
				}
			}
			if bounded.Err() != nil {
				return "", errors.New("adb_probe_timeout")
			}
			return "", errors.New("adb_probe_command_failed")
		}
		return string(raw), nil
	}
	if _, err = command("start-server"); err != nil {
		return nil, fmt.Errorf("adb_probe_server_failed:%w", err)
	}
	defer command("kill-server")
	// The separate checker has network=none; its test-only adb server and relay
	// cannot bind another node's existing ports or become a LAN debugging API.
	// Renew while the standard client establishes Android authentication.
	renewCtx, stopRenew := context.WithCancel(ctx)
	renewDone := make(chan struct{})
	go func() {
		defer close(renewDone)
		tick := time.NewTicker(time.Second)
		defer tick.Stop()
		for {
			select {
			case <-renewCtx.Done():
				return
			case <-tick.C:
				renew := media
				renew.LeaseExpiresAt = time.Now().Add(4500 * time.Millisecond).UnixMilli()
				_, _ = c.ExecutePhoneMedia(renewCtx, "renew", renew, ownership)
			}
		}
	}()
	defer func() { stopRenew(); <-renewDone }()
	connected, err := command("connect", serial)
	if err != nil || !strings.Contains(connected, "connected to") {
		if err != nil {
			return nil, err
		}
		return nil, errors.New("adb_driver_connect_failed")
	}
	value, err := command("-s", serial, "shell", "getprop", "sys.boot_completed")
	if err != nil || strings.TrimSpace(value) != "1" {
		if err != nil {
			return nil, err
		}
		return nil, errors.New("adb_driver_android_read_failed")
	}
	stopRenew()
	<-renewDone
	media.LeaseExpiresAt = time.Now().Add(4000 * time.Millisecond).UnixMilli()
	if _, err = c.ExecutePhoneMedia(ctx, "renew", media, ownership); err != nil {
		return nil, err
	}
	started := time.Now()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-ended:
	case <-time.After(8 * time.Second):
		return nil, errors.New("adb_driver_expiry_failed")
	}
	seconds := time.Since(started).Seconds()
	if seconds < 3.5 || seconds >= 8 {
		return nil, errors.New("adb_driver_expiry_timing_invalid")
	}
	media.LeaseExpiresAt = time.Now().Add(4 * time.Second).UnixMilli()
	if conn, err := c.OpenPhoneADB(ctx, media); err == nil {
		conn.Close()
		return nil, errors.New("expired_adb_reconnected")
	}
	current, err := c.ExecutePhone(ctx, "inspect", p, ownership)
	if err != nil || !current.AndroidReady || !current.MediaReady {
		return nil, errors.New("adb_driver_stopped_phone")
	}
	return map[string]any{"standardAdbRead": true, "defaultClosed": true, "foreignOwnerDenied": true, "controlGrantDenied": true, "expirySeconds": seconds, "expiredReconnectDenied": true, "androidMediaUnchanged": true, "publicEndpointAccepted": false}, nil
}
