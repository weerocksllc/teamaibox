//go:build linux

package phonepool

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// Only newly allocated fixture volumes are used. No actual guest is launched.
func checkInstallationMediaLinux(t *testing.T, p *Pool, mount string) {
	i := ComputerVolumeIdentity{ComputerID: "71000000-0000-4000-8000-000000000001", OwnerID: "71000000-0000-4000-8000-000000000002", NodeID: "71000000-0000-4000-8000-000000000003",
		VolumeID: "71000000-0000-4000-8000-000000000004", FirmwareID: "71000000-0000-4000-8000-000000000005", PoolID: p.config.PoolID, ProfileID: "synthetic-linux", DiskBytes: 4 << 20}
	guest, err := p.Handle(Request{Action: "computer-prepare", Computer: &i})
	if err != nil {
		t.Fatal(err)
	}
	disk := filepath.Join(mount, "volumes", i.VolumeID, "guest", "retained")
	if err = os.WriteFile(disk, []byte("guest data is separate"), 0600); err != nil {
		t.Fatal(err)
	}
	before, _ := os.Stat(disk)
	request := Request{Action: "computer-media-prepare", Computer: &i, MediaBytes: 2 << 20}
	media, err := p.Handle(request)
	if err != nil || media.ProjectID == guest.ProjectID {
		t.Fatal("separate media allocation", err)
	}
	directory := filepath.Join(mount, "installation-media", i.VolumeID, "installer")
	file := filepath.Join(directory, "fixture.iso")
	f, err := os.OpenFile(file, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	// Kernel enforcement, not a mocked capacity check: 3 MiB cannot fit in a
	// 2 MiB + metadata project. The guest's separate 6 MiB quota is untouched.
	if err = f.Chown(10001, 10001); err != nil {
		f.Close()
		t.Fatal(err)
	}
	allocation := exec.Command("fallocate", "-l", "3145728", "/proc/self/fd/3")
	allocation.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C"}
	allocation.ExtraFiles = []*os.File{f}
	allocation.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 10001, Gid: 10001, Groups: []uint32{}}}
	output, writeErr := allocation.CombinedOutput()
	f.Close()
	if writeErr == nil || !strings.Contains(string(output), "Disk quota exceeded") {
		t.Fatalf("expected unprivileged EDQUOT: %v %s", writeErr, output)
	}
	request.MediaBytes = 6 << 20
	if _, err = p.Handle(request); err != nil {
		t.Fatal("grow media quota", err)
	}
	if err = os.WriteFile(file, bytes.Repeat([]byte{21}, 3<<20), 0400); err != nil {
		t.Fatal(err)
	}
	request.MediaBytes = 1 << 20
	if _, err = p.Handle(request); err == nil {
		t.Fatal("shrunk below actual media usage")
	}
	request.MediaBytes = 4 << 20
	if _, err = p.Handle(request); err != nil {
		t.Fatal("release excess reservation", err)
	}
	if _, err = p.Handle(Request{Action: "computer-media-delete", Computer: &i}); err == nil {
		t.Fatal("deleted populated directory")
	}
	if err = os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if _, err = p.Handle(Request{Action: "computer-media-delete", Computer: &i}); err != nil {
		t.Fatal("release media", err)
	}
	after, _ := os.Stat(disk)
	raw, _ := os.ReadFile(disk)
	if !os.SameFile(before, after) || string(raw) != "guest data is separate" {
		t.Fatal("guest changed")
	}
	observed, err := p.Handle(Request{Action: "computer-inspect", Computer: &i})
	if err != nil || observed.ProjectID != guest.ProjectID || observed.QuotaBytes != guest.QuotaBytes {
		t.Fatal("guest identity/quota changed", err)
	}
	if _, err = p.Handle(Request{Action: "computer-delete", Computer: &i}); err != nil {
		t.Fatal("remove only synthetic guest", err)
	}
}
