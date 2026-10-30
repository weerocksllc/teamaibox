//go:build linux

package docker

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPhoneSocketsReachLongEncryptedPoolPathsWithoutAliases(t *testing.T) {
	for _, name := range []string{".media-control.sock", ".adb-stream.sock"} {
		t.Run(name, func(t *testing.T) {
			volume := "25a83a0b-8be0-4664-80a0-63c7cdda6bba"
			base := filepath.Join(t.TempDir(), strings.Repeat("p", 100), "volumes")
			dir := filepath.Join(base, volume, "phone")
			if err := os.MkdirAll(dir, 0700); err != nil {
				t.Fatal(err)
			}
			file, err := os.Open(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			short := fmt.Sprintf("/proc/self/fd/%d/%s", file.Fd(), name)
			listener, err := net.Listen("unix", short)
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			if err := os.Chmod(short, 0600); err != nil {
				t.Fatal(err)
			}
			// Reproduce the previous driver's exact failure before using the fix.
			if c, err := net.DialTimeout("unix", filepath.Join(dir, name), time.Second); err == nil {
				c.Close()
				t.Fatal("fixture did not exceed sockaddr_un")
			}
			root, err := os.OpenRoot(base)
			if err != nil {
				t.Fatal(err)
			}
			defer root.Close()
			connection, err := dialPhoneSocket(context.Background(), &net.Dialer{Timeout: time.Second}, root, base, volume, name)
			if err != nil {
				t.Fatal(err)
			}
			connection.Close()
			accepted, err := listener.Accept()
			if err != nil {
				t.Fatal(err)
			}
			accepted.Close()
			if err := os.Chmod(short, 0666); err != nil {
				t.Fatal(err)
			}
			if c, err := dialPhoneSocket(context.Background(), &net.Dialer{Timeout: time.Second}, root, base, volume, name); err == nil {
				c.Close()
				t.Fatal("unsafe socket mode accepted")
			}
		})
	}
}
