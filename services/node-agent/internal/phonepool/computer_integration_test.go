//go:build linux

package phonepool

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"teamaibox.local/node-agent/internal/agent"
)

// Explicit opt-in only. Creates a new sparse synthetic LUKS file, never accepts
// a block device or existing pool. No guest/office processes are stopped.
func TestComputerPoolLinuxEncryptedIntegration(t *testing.T) {
	computerPoolLinuxEncryptedFixture(t, false)
}

func TestInstallationMediaLinuxEncrypted(t *testing.T) {
	computerPoolLinuxEncryptedFixture(t, true)
}

func computerPoolLinuxEncryptedFixture(t *testing.T, installationOnly bool) {
	stage := os.Getenv("COMPUTER_POOL_TEST_ROOT")
	if stage == "" {
		t.Skip("requires an explicit isolated Linux storage fixture")
	}
	if os.Geteuid() != 0 || !privatePath(stage) || !strings.HasPrefix(filepath.Base(stage), "teamaibox-computer-pool-") {
		t.Fatal("invalid test root")
	}
	for _, tool := range []string{"cryptsetup", "mkfs.ext4", "mount", "umount", "blkid", "losetup", "fallocate"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Fatal("required existing tool unavailable", tool)
		}
	}
	root := filepath.Join(stage, "synthetic")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	file, mount := filepath.Join(root, "fixture.luks2"), filepath.Join(root, "mounted")
	if err := os.Mkdir(mount, 0700); err != nil {
		t.Fatal(err)
	}
	c := Config{PoolID: filepath.Base(stage), Root: mount, ClientUID: 10001, ComputerOverheadBytes: 2 << 20}
	mapper := "teamaibox-phone-" + c.PoolID
	if _, err := os.Lstat("/dev/mapper/" + mapper); !os.IsNotExist(err) {
		t.Fatal("test mapper already exists")
	}
	f, err := os.OpenFile(file, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	err = f.Truncate(32 << 30)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	key := make([]byte, 64)
	if _, err = rand.Read(key); err != nil {
		t.Fatal(err)
	}
	defer func() {
		for i := range key {
			key[i] = 0
		}
	}()
	command := func(input []byte, name string, args ...string) (string, error) {
		cmd := exec.Command(name, args...)
		if input != nil {
			cmd.Stdin = bytes.NewReader(input)
		}
		out, err := cmd.Output()
		if err != nil {
			return "", fmt.Errorf("fixture %s failed", name)
		}
		return strings.TrimSpace(string(out)), nil
	}
	mapped, mounted := false, false
	defer func() {
		// Never use forced/lazy unmount; keep precise leftovers on a failed cleanup.
		if mounted {
			if _, e := command(nil, "umount", mount); e != nil {
				t.Error(e)
				return
			}
		}
		if mapped {
			if _, e := command(nil, "cryptsetup", "close", mapper); e != nil {
				t.Error(e)
				return
			}
		}
		loops, e := command(nil, "losetup", "-j", file)
		if e != nil || loops != "" {
			t.Error("fixture loop remains")
			return
		}
		for _, path := range []string{file, mount, root} {
			if e = os.Remove(path); e != nil {
				t.Error("fixture cleanup failed")
				return
			}
		}
		fmt.Println("COMPUTER_POOL_FIXTURE_REMOVED")
	}()
	if _, err = command(key, "cryptsetup", "luksFormat", "--batch-mode", "--type", "luks2", "--pbkdf", "pbkdf2", "--pbkdf-force-iterations", "1000", "--key-file", "-", file); err != nil {
		t.Fatal(err)
	}
	if _, err = command(key, "cryptsetup", "open", "--key-file", "-", file, mapper); err != nil {
		t.Fatal(err)
	}
	mapped = true
	if _, err = command(nil, "mkfs.ext4", "-F", "-m", "0", "-O", "project,quota", "-E", "quotatype=prjquota,nodiscard", "/dev/mapper/"+mapper); err != nil {
		t.Fatal(err)
	}
	if _, err = command(nil, "mount", "-o", "nosuid,nodev,noexec,prjquota", "/dev/mapper/"+mapper, mount); err != nil {
		t.Fatal(err)
	}
	mounted = true
	c.LUKSUUID, err = command(nil, "cryptsetup", "luksUUID", file)
	if err != nil {
		t.Fatal(err)
	}
	c.FilesystemUUID, err = command(nil, "blkid", "-s", "UUID", "-o", "value", "/dev/mapper/"+mapper)
	if err != nil {
		t.Fatal(err)
	}
	identity, _ := json.Marshal(map[string]string{"poolId": c.PoolID, "luksUUID": c.LUKSUUID, "filesystemUUID": c.FilesystemUUID})
	if err = os.WriteFile(filepath.Join(mount, "pool.json"), identity, 0600); err != nil {
		t.Fatal(err)
	}
	p, err := New(c)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { p.Close() }()
	if installationOnly {
		checkInstallationMediaLinux(t, p, mount)
		return
	}
	i := ComputerVolumeIdentity{ComputerID: "61000000-0000-4000-8000-000000000001", OwnerID: "61000000-0000-4000-8000-000000000002", NodeID: "61000000-0000-4000-8000-000000000003",
		VolumeID: "61000000-0000-4000-8000-000000000004", FirmwareID: "61000000-0000-4000-8000-000000000005", TPMID: "61000000-0000-4000-8000-000000000006", PoolID: c.PoolID, ProfileID: "synthetic-windows", DiskBytes: 4 << 20}
	q := Request{Action: "computer-prepare", Computer: &i}
	r, err := p.Handle(q)
	if err != nil || r.QuotaBytes != 6<<20 {
		t.Fatal("prepare", err)
	}
	guest := filepath.Join(mount, "volumes", i.VolumeID, "guest")
	retained := filepath.Join(guest, "retained")
	if err = os.WriteFile(retained, []byte("synthetic-UEFI-TPM-disk-retained"), 0600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(retained)
	if err != nil {
		t.Fatal(err)
	}
	limited, err := os.OpenFile(filepath.Join(guest, "quota-check"), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	// Root/CAP_SYS_RESOURCE bypasses project limits. Pass only this synthetic
	// file descriptor to the same unprivileged identity used by guest runtimes.
	if err = limited.Chown(10001, 10001); err != nil {
		limited.Close()
		t.Fatal(err)
	}
	allocation := exec.Command("fallocate", "-l", "7340032", "/proc/self/fd/3")
	allocation.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C"}
	allocation.ExtraFiles = []*os.File{limited}
	allocation.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 10001, Gid: 10001, Groups: []uint32{}}}
	output, allocationErr := allocation.CombinedOutput()
	limited.Close()
	if allocationErr == nil || !strings.Contains(string(output), "Disk quota exceeded") {
		t.Fatalf("expected real unprivileged kernel EDQUOT, got %v %s", allocationErr, output)
	}
	if err = os.Remove(filepath.Join(guest, "quota-check")); err != nil {
		t.Fatal(err)
	}
	lock, err := os.OpenFile(filepath.Join(guest, "runtime.lock"), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	q.Action = "computer-delete"
	_, err = p.Handle(q)
	if err == nil || err.Error() != "computer_storage_in_use" {
		lock.Close()
		t.Fatal("active runtime lock ignored", err)
	}
	lock.Close()
	// Verify the exact inode and bytes after closing/reopening the encrypted pool.
	p.Close()
	if _, err = command(nil, "umount", mount); err != nil {
		t.Fatal(err)
	}
	mounted = false
	if _, err = command(nil, "cryptsetup", "close", mapper); err != nil {
		t.Fatal(err)
	}
	mapped = false
	if _, err = command(key, "cryptsetup", "open", "--key-file", "-", file, mapper); err != nil {
		t.Fatal(err)
	}
	mapped = true
	if _, err = command(nil, "mount", "-o", "nosuid,nodev,noexec,prjquota", "/dev/mapper/"+mapper, mount); err != nil {
		t.Fatal(err)
	}
	mounted = true
	p, err = New(c)
	if err != nil {
		t.Fatal(err)
	}
	q.Action = "computer-prepare"
	again, err := p.Handle(q)
	if err != nil || again.ProjectID != r.ProjectID || again.QuotaBytes != r.QuotaBytes {
		t.Fatal("reopen changed allocation", err)
	}
	after, err := os.Stat(retained)
	if err != nil || before.Sys().(*syscall.Stat_t).Ino != after.Sys().(*syscall.Stat_t).Ino {
		t.Fatal("inode changed")
	}
	raw, err := os.ReadFile(retained)
	if err != nil || string(raw) != "synthetic-UEFI-TPM-disk-retained" {
		t.Fatal("data changed")
	}
	phone := Request{Action: "prepare", Identity: agent.PhoneIdentity{PhoneID: "62000000-0000-4000-8000-000000000001", OwnerID: i.OwnerID, VolumeID: "62000000-0000-4000-8000-000000000002", PoolID: c.PoolID, BaseBuildID: agent.PhoneBaseBuild}}
	pr, err := p.Handle(phone)
	if err != nil || pr.ProjectID == r.ProjectID {
		t.Fatal("shared allocator", err)
	}
	q.Action = "computer-delete"
	if _, err = p.Handle(q); err != nil {
		t.Fatal("delete", err)
	}
	if _, err = p.Handle(q); err != nil {
		t.Fatal("delete replay", err)
	}
	phone.Action = "inspect"
	if _, err = p.Handle(phone); err != nil {
		t.Fatal("Android allocation changed", err)
	}
	phone.Action = "delete"
	if _, err = p.Handle(phone); err != nil {
		t.Fatal("fixture phone cleanup", err)
	}
	fmt.Println("COMPUTER_POOL_KERNEL_QUOTA_REOPEN_LOCK_AND_COEXISTENCE_PASSED")
}
