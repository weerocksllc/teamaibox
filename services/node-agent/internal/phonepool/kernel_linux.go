//go:build linux

package phonepool

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

type linuxKernel struct{}

func New(c Config) (*Pool, error) {
	if os.Geteuid() != 0 {
		return nil, errors.New("phone_pool_privileged_helper_required")
	}
	return newPool(c, linuxKernel{})
}
func (k linuxKernel) lock(f *os.File) error {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
}
func (k linuxKernel) capacity(c Config) (uint64, uint64, error) {
	// Verify the live encrypted mount and project quota, not just an installed flag.
	available, err := k.verify(c)
	if err != nil {
		return 0, 0, err
	}
	var fs syscall.Statfs_t
	if err = syscall.Statfs(c.Root, &fs); err != nil || fs.Type != 0xef53 {
		return 0, 0, errors.New("phone_storage_unavailable")
	}
	return fs.Blocks * uint64(fs.Bsize), available, nil
}
func (k linuxKernel) verify(c Config) (uint64, error) {
	if !privatePath(c.Root) {
		return 0, errors.New("phone_storage_unavailable")
	}
	var s syscall.Stat_t
	var fs syscall.Statfs_t
	if syscall.Stat(c.Root, &s) != nil || s.Uid != 0 || syscall.Statfs(c.Root, &fs) != nil || fs.Type != 0xef53 {
		return 0, errors.New("phone_storage_unavailable")
	}
	// dev_t layout from Linux sysmacros; dm numbers may change across reboot.
	major := (s.Dev>>8)&0xfff | (s.Dev>>32)&0xfffff000
	minor := s.Dev&0xff | (s.Dev>>12)&0xffffff00
	raw, err := os.ReadFile(fmt.Sprintf("/sys/dev/block/%d:%d/dm/uuid", major, minor))
	if err != nil || strings.TrimSpace(string(raw)) != "CRYPT-LUKS2-"+strings.ReplaceAll(c.LUKSUUID, "-", "")+"-teamaibox-phone-"+c.PoolID {
		return 0, errors.New("phone_storage_not_luks2")
	}
	// Verify that the current namespace sees a quota-enabled mount of this same
	// filesystem. Binding an ordinary directory with copied metadata cannot pass.
	mounts, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return 0, err
	}
	quota := false
	for _, line := range strings.Split(string(mounts), "\n") {
		fields := strings.Fields(line)
		if len(fields) > 8 && fields[2] == fmt.Sprintf("%d:%d", major, minor) && strings.Contains(line, " - ext4 ") && strings.Contains(line, "prjquota") {
			quota = true
		}
	}
	if !quota {
		return 0, errors.New("phone_storage_quota_inactive")
	}
	info, err := os.Lstat(filepath.Join(c.Root, "pool.json"))
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 4096 {
		return 0, errors.New("phone_pool_identity_invalid")
	}
	var identity struct {
		PoolID         string `json:"poolId"`
		LUKSUUID       string `json:"luksUUID"`
		FilesystemUUID string `json:"filesystemUUID"`
	}
	raw, err = os.ReadFile(filepath.Join(c.Root, "pool.json"))
	if err != nil || json.Unmarshal(raw, &identity) != nil || identity.PoolID != c.PoolID || identity.LUKSUUID != c.LUKSUUID || identity.FilesystemUUID != c.FilesystemUUID {
		return 0, errors.New("phone_pool_identity_invalid")
	}
	if c.ElasticBackingFile != "" || c.ElasticKeyFile != "" {
		return elasticCapacity(c, &fs)
	}
	return fs.Bavail * uint64(fs.Bsize), nil
}

type fsxattr struct {
	Flags, ExtentSize, Nextents, Project, CowExtent uint32
	Pad                                             [8]byte
}

func (k linuxKernel) project(f *os.File, id uint32, set bool) error {
	var x fsxattr
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), 0x801c581f, uintptr(unsafe.Pointer(&x))); e != 0 {
		return e
	}
	if set {
		// Existing nonzero project IDs are never silently reassigned.
		if x.Project != 0 && x.Project != id {
			return errors.New("phone_storage_project_mismatch")
		}
		x.Project = id
		x.Flags |= 0x200
		if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), 0x401c5820, uintptr(unsafe.Pointer(&x))); e != 0 {
			return e
		}
	}
	if x.Project != id || x.Flags&0x200 == 0 {
		return errors.New("phone_storage_project_mismatch")
	}
	return nil
}

type dqblk struct {
	BlockHard, BlockSoft, Used, InodeHard, InodeSoft, Inodes, Btime, Itime uint64
	Valid                                                                  uint32
	Pad                                                                    uint32
}

func (k linuxKernel) quota(f *os.File, id uint32, set, clear bool) (uint64, error) {
	return k.variableQuota(f, id, 16<<30, 32768, set, clear)
}

func (k linuxKernel) computerQuota(f *os.File, id uint32, bytes uint64, set, clear bool) (uint64, error) {
	// Guest filesystem inodes live inside qcow2. Do not inherit the Android
	// directory-tree inode limit as an undocumented Windows product restriction.
	if bytes == 0 || bytes%1024 != 0 {
		return 0, errors.New("computer_storage_quota_invalid")
	}
	return k.variableQuota(f, id, bytes, 0, set, clear)
}

// Only the separate installation-media project may resize. Guest disk quotas
// retain their existing immutable check in variableQuota.
func (k linuxKernel) resizeMediaQuota(f *os.File, id uint32, previous, next uint64, apply bool) (uint64, error) {
	var q dqblk
	call := func(cmd uintptr) error {
		_, _, e := syscall.Syscall6(443, f.Fd(), cmd, uintptr(id), uintptr(unsafe.Pointer(&q)), 0, 0)
		if e != 0 {
			return e
		}
		return nil
	}
	if next == 0 || next%1024 != 0 || previous%1024 != 0 {
		return 0, errors.New("computer_media_quota_invalid")
	}
	if err := call(0x80000702); err != nil {
		return 0, err
	}
	if q.BlockHard != previous/1024 && q.BlockHard != next/1024 || q.BlockSoft != 0 || q.InodeHard != 0 || q.InodeSoft != 0 {
		return 0, errors.New("computer_media_quota_changed")
	}
	if q.Used > next {
		return q.Used, errors.New("computer_media_storage_in_use")
	}
	if apply {
		q.BlockHard, q.BlockSoft, q.InodeHard, q.InodeSoft, q.Valid = next/1024, 0, 0, 0, 5
		if err := call(0x80000802); err != nil {
			return 0, err
		}
	}
	return q.Used, nil
}

func (k linuxKernel) variableQuota(f *os.File, id uint32, bytes, inodes uint64, set, clear bool) (uint64, error) {
	var q dqblk
	call := func(cmd uintptr) error {
		_, _, e := syscall.Syscall6(443, f.Fd(), cmd, uintptr(id), uintptr(unsafe.Pointer(&q)), 0, 0)
		if e != 0 {
			return e
		}
		return nil
	}
	if err := call(0x80000702); err != nil {
		return 0, err
	}
	if set {
		if q.BlockHard != 0 && q.BlockHard != bytes/1024 {
			return 0, errors.New("phone_storage_quota_changed")
		}
		q.BlockHard = bytes / 1024
		q.BlockSoft = 0
		q.InodeHard = inodes
		q.InodeSoft = 0
		q.Valid = 5
		if err := call(0x80000802); err != nil {
			return 0, err
		}
	}
	if clear {
		if q.Used != 0 || q.Inodes != 0 {
			return 0, errors.New("phone_storage_deletion_incomplete")
		}
		q.BlockHard = 0
		q.BlockSoft = 0
		q.InodeHard = 0
		q.InodeSoft = 0
		q.Valid = 5
		return 0, call(0x80000802)
	}
	if q.BlockHard != bytes/1024 || q.BlockSoft != 0 || q.InodeHard != inodes || q.InodeSoft != 0 {
		return 0, errors.New("phone_storage_quota_changed")
	}
	return q.Used, nil
}
func (k linuxKernel) ownership(root *os.Root, name string, uid uint32, mode os.FileMode) error {
	// Parent stays root-owned; only its private /phone child and run-control
	// directory are writable by the unprivileged Node Agent/runtime identity.
	owner := 0
	if strings.HasSuffix(name, "/phone") || strings.HasSuffix(name, "/guest") || strings.HasSuffix(name, "/installer") || name == "control" {
		owner = int(uid)
	}
	if err := root.Chown(name, owner, int(uid)); err != nil {
		return err
	}
	return root.Chmod(name, mode)
}
