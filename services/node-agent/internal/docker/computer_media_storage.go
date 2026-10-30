package docker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"teamaibox.local/node-agent/internal/agent"
	"teamaibox.local/node-agent/internal/phonepool"
)

var stagedMediaName = regexp.MustCompile(`^[a-f0-9]{64}\.(iso|partial)$`)

// Media staging serializes only the target volume, never all computers.
func (s *InstalledComputerStorage) lockInstallationVolume(volumeID string) func() {
	s.mediaMu.Lock()
	if s.mediaLocks == nil {
		s.mediaLocks = make(map[string]*sync.Mutex)
	}
	lock := s.mediaLocks[volumeID]
	if lock == nil {
		lock = &sync.Mutex{}
		s.mediaLocks[volumeID] = lock
	}
	s.mediaMu.Unlock()
	lock.Lock()
	return lock.Unlock
}

func (s *InstalledComputerStorage) installerDirectory(p agent.ComputerCommand) string {
	return filepath.Join(filepath.Dir(s.dataRoot), "installation-media", p.VolumeID, "installer")
}

func (s *InstalledComputerStorage) mediaCall(ctx context.Context, p agent.ComputerCommand, action string, bytes uint64) (phonepool.Result, error) {
	i, err := s.identity(p)
	if err != nil {
		return phonepool.Result{}, err
	}
	r, err := s.storage.Handle(ctx, phonepool.Request{Action: "computer-media-" + action, Computer: &i, MediaBytes: bytes})
	if err != nil {
		return r, err
	}
	if !r.Media || r.Computer == nil || *r.Computer != i || r.ProjectID < 100000 || r.QuotaBytes == 0 || r.QuotaBytes >= 1<<53 ||
		r.QuotaBytes%1024 != 0 || action == "prepare" && r.Deleted || action == "delete" && !r.Deleted {
		return phonepool.Result{}, errors.New("computer_media_storage_reply_invalid")
	}
	return r, nil
}

// New empty drives allocate only their own directory metadata. Reopening must
// inspect, not resize an existing staging project down to an empty reservation.
func (s *InstalledComputerStorage) EnsureInstallationDirectory(ctx context.Context, p agent.ComputerCommand) (string, error) {
	unlock := s.lockInstallationVolume(p.VolumeID)
	defer unlock()
	r, err := s.mediaCall(ctx, p, "inspect", 0)
	if err != nil && err.Error() != "computer_media_storage_missing" {
		return "", err
	}
	if err != nil || r.Deleted {
		if _, err = s.mediaCall(ctx, p, "prepare", 0); err != nil {
			return "", err
		}
	}
	return s.installerDirectory(p), nil
}

func stagingSize(root *os.Root, skip string) (uint64, error) {
	f, err := root.Open(".")
	if err != nil {
		return 0, err
	}
	defer f.Close()
	entries, err := f.Readdir(-1)
	if err != nil {
		return 0, err
	}
	var total uint64
	for _, entry := range entries {
		if !stagedMediaName.MatchString(entry.Name()) || !entry.Mode().IsRegular() || entry.Size() < 0 {
			return 0, errors.New("computer_media_staging_invalid")
		}
		if entry.Name() == skip {
			continue
		}
		if total >= 1<<53-uint64(entry.Size()) {
			return 0, errors.New("computer_media_size_invalid")
		}
		total += uint64(entry.Size())
	}
	return total, nil
}

type contextMediaReader struct {
	ctx    context.Context
	source io.Reader
}

func (r contextMediaReader) Read(b []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.source.Read(b)
}

func verifyStagedMedia(ctx context.Context, root *os.Root, name, digest string, size int64) error {
	i, err := root.Lstat(name)
	if err != nil || !i.Mode().IsRegular() || i.Size() != size {
		return errors.New("computer_media_staging_invalid")
	}
	f, err := root.Open(name)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.CopyBuffer(h, contextMediaReader{ctx, f}, make([]byte, 1<<20)); err != nil {
		return err
	}
	if "sha256:"+hex.EncodeToString(h.Sum(nil)) != digest {
		return errors.New("computer_media_digest_mismatch")
	}
	return nil
}

// Source is supplied by the authenticated object transport, never a member URL
// or host path. Caller keeps the source request bound to owner/object/version.
func (s *InstalledComputerStorage) StageInstallationMedia(ctx context.Context, p agent.ComputerCommand, digest string, size int64, source io.Reader) error {
	if !digestID.MatchString(digest) || size <= 0 || size >= 1<<53 || source == nil || s.mediaOwnership == nil {
		return errors.New("computer_media_input_invalid")
	}
	if _, err := s.EnsureInstallationDirectory(ctx, p); err != nil {
		return err
	}
	unlock := s.lockInstallationVolume(p.VolumeID)
	defer unlock()
	root, err := os.OpenRoot(s.installerDirectory(p))
	if err != nil {
		return err
	}
	defer root.Close()
	name, partial := digest[7:]+".iso", digest[7:]+".partial"
	if _, err = root.Lstat(name); err == nil {
		return verifyStagedMedia(ctx, root, name, digest, size)
	} else if !os.IsNotExist(err) {
		return err
	}
	total, err := stagingSize(root, partial)
	if err != nil {
		return err
	}
	if total >= 1<<53-uint64(size) {
		return errors.New("computer_media_size_invalid")
	}
	if _, err = s.mediaCall(ctx, p, "prepare", total+uint64(size)); err != nil {
		return err
	}
	f, err := root.OpenFile(partial, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		f.Close()
		if !committed {
			_ = root.Remove(partial)
		}
		// Release unwritten bytes after a failed transfer. If the helper itself
		// is unavailable, leave the durable reservation for the next retry.
		if bytes, e := stagingSize(root, ""); e == nil {
			cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, _ = s.mediaCall(cleanup, p, "prepare", bytes)
		}
	}()
	h := sha256.New()
	n, err := io.CopyBuffer(io.MultiWriter(f, h), io.LimitReader(contextMediaReader{ctx, source}, size+1), make([]byte, 1<<20))
	if err != nil {
		return err
	}
	if n != size || "sha256:"+hex.EncodeToString(h.Sum(nil)) != digest {
		return errors.New("computer_media_digest_mismatch")
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = s.mediaOwnership(f); err != nil {
		return err
	}
	if err = f.Chmod(0400); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = root.Rename(partial, name); err != nil {
		return err
	}
	committed = true
	dir, err := root.Open(".")
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

// Called only after cleanupStoppedComputer has verified and removed every
// exact runtime container. This is not the optical eject path.
func (s *InstalledComputerStorage) deleteInstallationStaging(ctx context.Context, p agent.ComputerCommand) error {
	unlock := s.lockInstallationVolume(p.VolumeID)
	defer unlock()
	r, err := s.mediaCall(ctx, p, "inspect", 0)
	if err != nil && err.Error() == "computer_media_storage_missing" {
		return nil
	}
	if err != nil && err.Error() != "computer_media_storage_pending" {
		return err
	}
	if err == nil && r.Deleted {
		return nil
	}
	root, openErr := os.OpenRoot(s.installerDirectory(p))
	if openErr != nil && !os.IsNotExist(openErr) {
		return openErr
	}
	if openErr == nil {
		defer root.Close()
		if _, err = stagingSize(root, ""); err != nil {
			return err
		}
		f, err := root.Open(".")
		if err != nil {
			return err
		}
		names, err := f.Readdirnames(-1)
		f.Close()
		if err != nil {
			return err
		}
		for _, name := range names {
			if err = root.Remove(name); err != nil {
				return err
			}
		}
		root.Close()
	}
	_, err = s.mediaCall(ctx, p, "delete", 0)
	return err
}
