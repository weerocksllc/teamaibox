//go:build linux

package phonepool

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// The root-owned installation supplies both paths. No member request can
// choose a device, key, capacity, executable, or command argument.
func elasticCommand(key *os.File, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	if key != nil {
		cmd.ExtraFiles = []*os.File{key}
	}
	out, err := cmd.Output()
	if err != nil {
		return nil, errors.New("guest_storage_growth_failed")
	}
	return out, nil
}

func elasticCapacity(c Config, fs *syscall.Statfs_t) (uint64, error) {
	fail := errors.New("guest_storage_backing_invalid")
	if !filepath.IsAbs(c.ElasticBackingFile) || filepath.Clean(c.ElasticBackingFile) != c.ElasticBackingFile ||
		!privatePath(filepath.Dir(c.ElasticBackingFile)) || !filepath.IsAbs(c.ElasticKeyFile) ||
		filepath.Clean(c.ElasticKeyFile) != c.ElasticKeyFile || !privatePath(filepath.Dir(c.ElasticKeyFile)) {
		return 0, fail
	}
	fd, err := syscall.Open(c.ElasticBackingFile, syscall.O_RDWR|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return 0, fail
	}
	f := os.NewFile(uintptr(fd), c.ElasticBackingFile)
	defer f.Close()
	var st syscall.Stat_t
	if syscall.Fstat(fd, &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Uid != 0 || st.Nlink != 1 {
		return 0, fail
	}
	// Use a separate lock: cryptsetup itself locks the backing inode. Holding
	// that inode while waiting for cryptsetup would deadlock the child process.
	lockFD, err := syscall.Open(filepath.Join(c.Root, ".elastic-growth.lock"), syscall.O_WRONLY|syscall.O_CREAT|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return 0, fail
	}
	defer syscall.Close(lockFD)
	if syscall.Flock(lockFD, syscall.LOCK_EX) != nil {
		return 0, fail
	}
	defer syscall.Flock(lockFD, syscall.LOCK_UN)
	mapper := "teamaibox-phone-" + c.PoolID
	status, err := elasticCommand(nil, "cryptsetup", "status", mapper)
	if err != nil {
		return 0, err
	}
	var loop string
	for _, line := range strings.Split(string(status), "\n") {
		parts := strings.Fields(line)
		if len(parts) == 2 && parts[0] == "device:" {
			loop = parts[1]
		}
	}
	if !strings.HasPrefix(loop, "/dev/loop") || strings.TrimPrefix(loop, "/dev/loop") == "" {
		return 0, fail
	}
	for _, ch := range strings.TrimPrefix(loop, "/dev/loop") {
		if ch < '0' || ch > '9' {
			return 0, fail
		}
	}
	actual, err := elasticCommand(nil, "losetup", "-n", "-O", "BACK-FILE", loop)
	if err != nil || strings.TrimSpace(string(actual)) != c.ElasticBackingFile {
		return 0, fail
	}
	var host syscall.Statfs_t
	if syscall.Statfs(filepath.Dir(c.ElasticBackingFile), &host) != nil {
		return 0, fail
	}
	target := host.Blocks * uint64(host.Bsize) / 4096 * 4096
	if target == 0 || target > uint64(^uint64(0)>>1) {
		return 0, fail
	}
	// Grow only the sparse address space, not a preallocation of the entire host
	// disk. The free-space result below is bounded by the physical filesystem.
	// Re-run mapping/filesystem resize after an interrupted extension as well.
	if uint64(st.Size) < target || fs.Blocks*uint64(fs.Bsize) < uint64(st.Size)*95/100 {
		keyFD, e := syscall.Open(c.ElasticKeyFile, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if e != nil {
			return 0, fail
		}
		key := os.NewFile(uintptr(keyFD), "guest-pool-key")
		defer key.Close()
		var ks syscall.Stat_t
		if syscall.Fstat(keyFD, &ks) != nil || ks.Mode&syscall.S_IFMT != syscall.S_IFREG || ks.Uid != 0 || ks.Mode&0077 != 0 || ks.Size != 64 || ks.Nlink != 1 {
			return 0, fail
		}
		if _, e = elasticCommand(key, "cryptsetup", "open", "--test-passphrase", "--type", "luks2", "--key-file", "/proc/self/fd/3", c.ElasticBackingFile); e != nil {
			return 0, e
		}
		if uint64(st.Size) < target {
			if e = f.Truncate(int64(target)); e != nil {
				return 0, e
			}
			if e = f.Sync(); e != nil {
				return 0, e
			}
		}
		if _, e = elasticCommand(nil, "losetup", "--set-capacity", loop); e != nil {
			return 0, e
		}
		if _, e = key.Seek(0, 0); e != nil {
			return 0, e
		}
		if _, e = elasticCommand(key, "cryptsetup", "resize", mapper, "--key-file", "/proc/self/fd/3"); e != nil {
			return 0, e
		}
		if _, e = elasticCommand(nil, "resize2fs", "/dev/mapper/"+mapper); e != nil {
			return 0, e
		}
		if syscall.Statfs(c.Root, fs) != nil || syscall.Statfs(filepath.Dir(c.ElasticBackingFile), &host) != nil {
			return 0, fail
		}
	}
	return boundedPhysicalAvailability(fs.Bavail*uint64(fs.Bsize), host.Bavail*uint64(host.Bsize)), nil
}
