package docker

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

func mediaSocketFixture(t *testing.T, handle func(net.Conn, agent.PhoneMediaPayload)) (string, agent.PhoneMediaPayload) {
	t.Helper()
	_, base := phoneRecipeFixture(t)
	p := agent.PhoneMediaPayload{PhoneCommandPayload: base, GrantID: base.OperationID, SessionID: base.OwnerID, Kind: "control", LeaseExpiresAt: time.Now().Add(4 * time.Second).UnixMilli()}
	// macOS unix socket names are short; this new test-owned directory contains
	// only synthetic messages, not a real phone disk or credential.
	root, err := os.MkdirTemp("/tmp", "phone-media-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	directory := filepath.Join(root, p.VolumeID, "phone")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, ".media-control.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		connection, err := listener.Accept()
		if err == nil {
			defer connection.Close()
			handle(connection, p)
		}
	}()
	t.Cleanup(func() { listener.Close(); <-done })
	return root, p
}
func TestPhoneMediaUnixSocketUsesFixedGrantAndRejectsInexactReplies(t *testing.T) {
	for _, wrong := range []bool{false, true} {
		t.Run(map[bool]string{false: "exact", true: "other_run"}[wrong], func(t *testing.T) {
			root, p := mediaSocketFixture(t, func(connection net.Conn, p agent.PhoneMediaPayload) {
				var request struct {
					Action         string                `json:"action"`
					Grant          agent.PhoneMediaGrant `json:"grant"`
					LeaseExpiresAt int64                 `json:"leaseExpiresAt"`
				}
				d := json.NewDecoder(connection)
				d.DisallowUnknownFields()
				if d.Decode(&request) != nil || request.Action != "renew" || request.Grant != p.Grant() || request.LeaseExpiresAt != p.LeaseExpiresAt {
					t.Error("inexact local request")
					return
				}
				result := agent.PhoneMediaResult{PhoneMediaGrant: p.Grant(), PeerOpen: true, LeaseExpiresAt: p.LeaseExpiresAt}
				if wrong {
					result.RunID = p.OwnerID
				}
				json.NewEncoder(connection).Encode(result)
			})
			value, err := phoneMediaSocket(context.Background(), root, p, "renew")
			if wrong {
				if err == nil {
					t.Fatal("another phone accepted")
				}
			} else if err != nil || !value.PeerOpen {
				t.Fatalf("%+v %v", value, err)
			}
		})
	}
}
func TestPhoneMediaUnixSocketCancellationIsBounded(t *testing.T) {
	root, p := mediaSocketFixture(t, func(connection net.Conn, _ agent.PhoneMediaPayload) {
		buffer := make([]byte, 4096)
		for {
			if _, err := connection.Read(buffer); err != nil {
				return
			}
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := phoneMediaSocket(ctx, root, p, "open"); err == nil {
		t.Fatal("silent local runtime accepted")
	}
	if time.Since(start) > time.Second {
		t.Fatal("deadline not enforced")
	}
}
func TestPhoneMediaDriverRejectsForeignContainerAndAcknowledgesOnlyExactStoppedRun(t *testing.T) {
	d, _, state, p := phoneDriverFixture(t)
	media := agent.PhoneMediaPayload{PhoneCommandPayload: p, GrantID: p.OperationID, SessionID: p.OwnerID, Kind: "control"}
	state.State.Running = false
	state.State.Status = "exited"
	value, err := d.ControlPhoneMedia(context.Background(), "close", media)
	if err != nil || !value.PeerClosed {
		t.Fatalf("exact stopped run %+v %v", value, err)
	}
	state.Image = "sha256:foreign"
	if _, err := d.ControlPhoneMedia(context.Background(), "close", media); err == nil {
		t.Fatal("foreign container accepted")
	}
}
