package docker

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

func adbSocketFixture(t *testing.T, handle func(net.Conn, agent.PhoneMediaPayload)) (string, agent.PhoneMediaPayload) {
	t.Helper()
	_, base := phoneRecipeFixture(t)
	p := agent.PhoneMediaPayload{PhoneCommandPayload: base, GrantID: base.OperationID, SessionID: base.OwnerID, Kind: "adb", LeaseExpiresAt: time.Now().Add(4 * time.Second).UnixMilli()}
	root, err := os.MkdirTemp("/tmp", "phone-adb-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	directory := filepath.Join(root, p.VolumeID, "phone")
	if err = os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, ".adb-stream.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(path, 0600); err != nil {
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

func TestPhoneADBSocketBindsExactGrantAndKeepsBytesAfterAcknowledgement(t *testing.T) {
	root, p := adbSocketFixture(t, func(c net.Conn, p agent.PhoneMediaPayload) {
		_ = c.SetDeadline(time.Now().Add(3 * time.Second))
		var grant agent.PhoneMediaGrant
		decoder := json.NewDecoder(c)
		decoder.DisallowUnknownFields()
		if decoder.Decode(&grant) != nil || grant != p.Grant() {
			t.Error("inexact grant")
			return
		}
		_, _ = c.Write([]byte("{\"ready\":true}\nCNXN\x00\xff"))
		var ack [2]byte
		_, _ = io.ReadFull(c, ack[:])
	})
	c, err := phoneADBSocket(context.Background(), root, p)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(time.Second))
	raw := make([]byte, 6)
	if _, err = io.ReadFull(c, raw); err != nil || string(raw) != "CNXN\x00\xff" {
		t.Fatalf("lost buffered bytes: %q %v", raw, err)
	}
	_, _ = c.Write([]byte("OK"))
}
func TestPhoneADBSocketRejectsPathsModesKindsAndInvalidReply(t *testing.T) {
	for _, scenario := range []string{"reply", "permissions", "symlink", "foreign-volume", "control"} {
		t.Run(scenario, func(t *testing.T) {
			root, p := adbSocketFixture(t, func(c net.Conn, _ agent.PhoneMediaPayload) {
				_ = c.SetDeadline(time.Now().Add(time.Second))
				var grant agent.PhoneMediaGrant
				_ = json.NewDecoder(c).Decode(&grant)
				_, _ = c.Write([]byte("{\"ready\":false}\n"))
			})
			path := filepath.Join(root, p.VolumeID, "phone", ".adb-stream.sock")
			switch scenario {
			case "permissions":
				if err := os.Chmod(path, 0666); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Rename(path, path+"-owned"); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(path+"-owned", path); err != nil {
					t.Fatal(err)
				}
			case "foreign-volume":
				p.VolumeID = "../../outside"
			case "control":
				p.Kind = "control"
			}
			if c, err := phoneADBSocket(context.Background(), root, p); err == nil {
				c.Close()
				t.Fatal("invalid ADB boundary accepted")
			}
		})
	}
}
func TestPhoneADBSocketHonorsCancelledHandshake(t *testing.T) {
	root, p := adbSocketFixture(t, func(c net.Conn, _ agent.PhoneMediaPayload) { _, _ = io.Copy(io.Discard, c) })
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	start := time.Now()
	if c, err := phoneADBSocket(ctx, root, p); err == nil {
		c.Close()
		t.Fatal("silent peer accepted")
	}
	if time.Since(start) > time.Second {
		t.Fatal("cancelled handshake remained open")
	}
}
func TestPhoneADBDriverRejectsNotReadyAndWrongContainer(t *testing.T) {
	d, _, state, p := phoneDriverFixture(t)
	media := agent.PhoneMediaPayload{PhoneCommandPayload: p, GrantID: p.OperationID, SessionID: p.OwnerID, Kind: "adb"}
	state.State.Running = false
	state.State.Status = "exited"
	if c, err := d.OpenPhoneADB(context.Background(), media); err == nil {
		c.Close()
		t.Fatal("stopped phone accepted")
	}
	state.Image = "sha256:foreign"
	if c, err := d.OpenPhoneADB(context.Background(), media); err == nil {
		c.Close()
		t.Fatal("another container accepted")
	}
}
