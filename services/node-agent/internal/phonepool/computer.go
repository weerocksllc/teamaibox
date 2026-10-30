package phonepool

import (
	"errors"
	"math"
	"os"
	"path/filepath"
	"regexp"

	"teamaibox.local/node-agent/internal/agent"
)

// Windows uses the installed encrypted pool and its single project allocator,
// not an Android identity, ROM, fixed disk size or separate storage daemon.
// Only the authenticated local Agent can call this socket. No caller paths,
// shell commands, keys or guest passwords are accepted.
type ComputerVolumeIdentity struct {
	ComputerID string `json:"computerId"`
	OwnerID    string `json:"ownerId"`
	NodeID     string `json:"nodeId"`
	VolumeID   string `json:"volumeId"`
	FirmwareID string `json:"firmwareId"`
	TPMID      string `json:"tpmId"`
	PoolID     string `json:"poolId"`
	ProfileID  string `json:"profileId"`
	DiskBytes  uint64 `json:"diskBytes"`
}

type computerRecord struct {
	Identity   ComputerVolumeIdentity `json:"identity"`
	ProjectID  uint32                 `json:"projectId"`
	QuotaBytes uint64                 `json:"quotaBytes"`
	Phase      string                 `json:"phase"`
}

type computerQuotaKernel interface {
	computerQuota(*os.File, uint32, uint64, bool, bool) (uint64, error)
}

var computerProfile = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)

func validComputerVolume(i ComputerVolumeIdentity, c Config) bool {
	return uuidID.MatchString(i.ComputerID) && uuidID.MatchString(i.OwnerID) && uuidID.MatchString(i.NodeID) &&
		uuidID.MatchString(i.VolumeID) && uuidID.MatchString(i.FirmwareID) && (i.TPMID == "" || uuidID.MatchString(i.TPMID)) &&
		i.PoolID == c.PoolID && computerProfile.MatchString(i.ProfileID) && i.DiskBytes > 0 && i.DiskBytes < 1<<53 && i.DiskBytes%512 == 0
}

func (p *Pool) validateComputers(j journal, projects map[uint32]bool) error {
	computers := map[string]bool{}
	for id, r := range j.Computers {
		_, phoneVolume := j.Volumes[id]
		if id != r.Identity.VolumeID || phoneVolume || !validComputerVolume(r.Identity, p.config) ||
			r.ProjectID < 100000 || r.ProjectID >= j.NextProject || projects[r.ProjectID] || computers[r.Identity.ComputerID] ||
			r.QuotaBytes <= r.Identity.DiskBytes || r.QuotaBytes >= 1<<53 || r.QuotaBytes%1024 != 0 ||
			(r.Phase != "preparing" && r.Phase != "ready" && r.Phase != "deleting" && r.Phase != "deleted") {
			return errors.New("computer_storage_record_invalid")
		}
		projects[r.ProjectID], computers[r.Identity.ComputerID] = true, true
	}
	return nil
}

func (p *Pool) handleComputer(q Request) (Result, error) {
	var result Result
	k, ok := p.kernel.(computerQuotaKernel)
	if !ok || q.Computer == nil || q.Identity != (agent.PhoneIdentity{}) || !validComputerVolume(*q.Computer, p.config) ||
		(q.Action != "computer-prepare" && q.Action != "computer-inspect" && q.Action != "computer-delete") {
		return result, errors.New("computer_storage_request_invalid")
	}
	i := *q.Computer
	available, err := p.kernel.verify(p.config)
	if err != nil {
		return result, err
	}
	j, err := p.read()
	if err != nil {
		return result, err
	}
	r, exists := j.Computers[i.VolumeID]
	if _, collision := j.Volumes[i.VolumeID]; collision {
		return result, errors.New("computer_storage_binding_mismatch")
	}
	if exists && r.Identity != i {
		return result, errors.New("computer_storage_binding_mismatch")
	}
	for _, other := range j.Computers {
		if other.Identity.ComputerID == i.ComputerID && other.Identity.VolumeID != i.VolumeID {
			return result, errors.New("computer_storage_binding_mismatch")
		}
	}
	if !exists && q.Action != "computer-prepare" {
		return result, errors.New("computer_storage_binding_missing")
	}
	mount, err := p.root.Open(".")
	if err != nil {
		return result, err
	}
	defer mount.Close()
	base := filepath.Join("volumes", i.VolumeID)
	if q.Action == "computer-prepare" {
		if exists && r.Phase != "preparing" && r.Phase != "ready" {
			return result, errors.New("computer_storage_deleted")
		}
		if !exists {
			overhead := p.config.ComputerOverheadBytes
			if overhead == 0 || overhead >= 1<<53 || overhead+i.DiskBytes+1023 >= 1<<53 {
				return result, errors.New("computer_storage_not_configured")
			}
			if j.NextProject == math.MaxUint32 {
				return result, errors.New("computer_storage_project_ids_exhausted")
			}
			quota := (i.DiskBytes + overhead + 1023) / 1024 * 1024
			if available == 0 {
				return result, errors.New("computer_storage_capacity_unavailable")
			}
			if _, e := p.root.Lstat(base); !os.IsNotExist(e) {
				return result, errors.New("computer_storage_unowned_data")
			}
			r = computerRecord{Identity: i, ProjectID: j.NextProject, QuotaBytes: quota, Phase: "preparing"}
			j.NextProject++
			if j.Computers == nil {
				j.Computers = map[string]computerRecord{}
			}
			j.Computers[i.VolumeID] = r
			if err = p.write(j); err != nil {
				return result, err
			}
		}
		if r.Phase == "preparing" {
			if err = p.directory(base); err != nil {
				return result, err
			}
			f, e := p.root.Open(base)
			if e != nil {
				return result, e
			}
			err = p.kernel.project(f, r.ProjectID, true)
			f.Close()
			if err != nil {
				return result, err
			}
			if _, err = k.computerQuota(mount, r.ProjectID, r.QuotaBytes, true, false); err != nil {
				return result, err
			}
			if err = p.directory(base + "/guest"); err != nil {
				return result, err
			}
			if err = p.kernel.ownership(p.root, base, p.config.ClientUID, 0750); err != nil {
				return result, err
			}
			if err = p.kernel.ownership(p.root, base+"/guest", p.config.ClientUID, 0700); err != nil {
				return result, err
			}
			r.Phase = "ready"
			j.Computers[i.VolumeID] = r
			if err = p.write(j); err != nil {
				return result, err
			}
		}
	}
	result = Result{Computer: &i, ProjectID: r.ProjectID, QuotaBytes: r.QuotaBytes, Deleted: r.Phase == "deleted"}
	if q.Action == "computer-delete" {
		if media, exists := j.ComputerMedia[i.VolumeID]; exists && media.Phase != "deleted" {
			return result, errors.New("computer_media_storage_in_use")
		}
		if r.Phase == "deleted" {
			return result, nil
		}
		// Agent first checks all exact run containers. The runtime's existing
		// file lock also refuses removal while a QEMU process holds the volume.
		var runtimeLock *os.File
		if info, e := p.root.Lstat(base); e == nil {
			if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return result, errors.New("computer_storage_path_invalid")
			}
			lock, e := p.lockComputerForDelete(base)
			if e != nil {
				return result, e
			}
			if lock != nil {
				runtimeLock = lock
				defer lock.Close()
			}
		} else if !os.IsNotExist(e) {
			return result, e
		}
		r.Phase = "deleting"
		j.Computers[i.VolumeID] = r
		if err = p.write(j); err != nil {
			return result, err
		}
		if err = p.root.RemoveAll(base); err != nil {
			return result, err
		}
		// Keep the lock through removal, then close the now-unlinked inode before
		// checking quota usage. Holding it open itself keeps one inode charged.
		if runtimeLock != nil {
			if err = runtimeLock.Close(); err != nil {
				return result, err
			}
		}
		if _, err = k.computerQuota(mount, r.ProjectID, r.QuotaBytes, false, true); err != nil {
			return result, err
		}
		r.Phase = "deleted"
		j.Computers[i.VolumeID] = r
		if err = p.write(j); err != nil {
			return result, err
		}
		result.Deleted = true
		return result, nil
	}
	if q.Action == "computer-inspect" && r.Phase == "deleted" {
		if _, err := p.root.Lstat(base); !os.IsNotExist(err) {
			return result, errors.New("computer_storage_path_invalid")
		}
		return result, nil
	}
	if r.Phase != "ready" {
		return result, errors.New("computer_storage_not_ready")
	}
	for _, name := range []string{base, base + "/guest"} {
		info, e := p.root.Lstat(name)
		if e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return result, errors.New("computer_storage_path_invalid")
		}
		f, e := p.root.Open(name)
		if e != nil {
			return result, e
		}
		err = p.kernel.project(f, r.ProjectID, false)
		f.Close()
		if err != nil {
			return result, err
		}
	}
	result.UsedBytes, err = k.computerQuota(mount, r.ProjectID, r.QuotaBytes, false, false)
	return result, err
}

func (p *Pool) lockComputerForDelete(base string) (*os.File, error) {
	guest, err := p.root.Lstat(base + "/guest")
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil || !guest.IsDir() || guest.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("computer_storage_path_invalid")
	}
	name := base + "/guest/runtime.lock"
	info, err := p.root.Lstat(name)
	if os.IsNotExist(err) {
		return nil, nil
	} // Never started/provisioned.
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("computer_storage_lock_invalid")
	}
	f, err := p.root.OpenFile(name, os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	if err = p.kernel.lock(f); err != nil {
		f.Close()
		return nil, errors.New("computer_storage_in_use")
	}
	return f, nil
}
