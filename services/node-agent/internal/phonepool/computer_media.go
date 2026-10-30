package phonepool

import (
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"

	"teamaibox.local/node-agent/internal/agent"
)

// Installation media has its own project on the verified encrypted filesystem.
// It never consumes a guest's fixed disk quota. The parent remains root-owned;
// the Agent writes the installer child, mounted read-only into just this guest.
type computerMediaRecord struct {
	Identity      ComputerVolumeIdentity `json:"identity"`
	ProjectID     uint32                 `json:"projectId"`
	QuotaBytes    uint64                 `json:"quotaBytes"`
	PreviousQuota uint64                 `json:"previousQuota"`
	Phase         string                 `json:"phase"`
}

type mediaQuotaKernel interface {
	resizeMediaQuota(*os.File, uint32, uint64, uint64, bool) (uint64, error)
}

const mediaDirectoryOverhead uint64 = 64 << 10 // Directory/partial-file metadata, not an ISO size limit.

func mediaQuota(bytes uint64) (uint64, error) {
	if bytes >= (1<<53)-mediaDirectoryOverhead-1024 {
		return 0, errors.New("computer_media_size_invalid")
	}
	return (bytes + mediaDirectoryOverhead + 1023) / 1024 * 1024, nil
}

func (p *Pool) validateComputerMedia(j journal, projects map[uint32]bool) error {
	for id, r := range j.ComputerMedia {
		computer, exists := j.Computers[id]
		if !exists || r.Identity != computer.Identity || id != r.Identity.VolumeID ||
			r.ProjectID < 100000 || r.ProjectID >= j.NextProject || projects[r.ProjectID] ||
			r.QuotaBytes < mediaDirectoryOverhead || r.QuotaBytes >= 1<<53 || r.QuotaBytes%1024 != 0 ||
			r.PreviousQuota >= 1<<53 || r.PreviousQuota%1024 != 0 ||
			(r.Phase != "preparing" && r.Phase != "ready" && r.Phase != "deleting" && r.Phase != "deleted") ||
			(r.Phase == "ready" && r.PreviousQuota != r.QuotaBytes) ||
			(computer.Phase == "deleted" && r.Phase != "deleted") {
			return errors.New("computer_media_record_invalid")
		}
		projects[r.ProjectID] = true
	}
	return nil
}

func (p *Pool) handleComputerMedia(q Request) (Result, error) {
	var result Result
	k, ok := p.kernel.(mediaQuotaKernel)
	quotaKernel, quotaOK := p.kernel.(computerQuotaKernel)
	if !ok || !quotaOK || q.Computer == nil || q.Identity != (agent.PhoneIdentity{}) || !validComputerVolume(*q.Computer, p.config) ||
		q.Action != "computer-media-prepare" && q.MediaBytes != 0 {
		return result, errors.New("computer_media_request_invalid")
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
	computer, exists := j.Computers[i.VolumeID]
	if !exists || computer.Identity != i || computer.Phase != "ready" {
		return result, errors.New("computer_storage_binding_mismatch")
	}
	r, exists := j.ComputerMedia[i.VolumeID]
	if exists && r.Identity != i {
		return result, errors.New("computer_storage_binding_mismatch")
	}
	if !exists && q.Action != "computer-media-prepare" {
		return result, errors.New("computer_media_storage_missing")
	}
	mount, err := p.root.Open(".")
	if err != nil {
		return result, err
	}
	defer mount.Close()
	base := filepath.Join("installation-media", i.VolumeID)
	// Finish only the already journaled reservation after helper interruption;
	// an observation cannot invent a different quota or replay guest work.
	if q.Action == "computer-media-inspect" && r.Phase == "preparing" {
		q.Action, q.MediaBytes = "computer-media-prepare", r.QuotaBytes-mediaDirectoryOverhead
	}
	if q.Action == "computer-media-prepare" {
		if r.Phase == "deleting" {
			return result, errors.New("computer_media_storage_in_use")
		}
		quota, e := mediaQuota(q.MediaBytes)
		if e != nil {
			return result, e
		}
		if !exists || r.Phase == "deleted" || quota != r.QuotaBytes {
			if r.Phase == "preparing" {
				return result, errors.New("computer_media_storage_pending")
			}
			used := uint64(0)
			previous := uint64(0)
			project := r.ProjectID
			if exists && r.Phase != "deleted" {
				previous = r.QuotaBytes
				used, err = k.resizeMediaQuota(mount, project, previous, quota, false)
				if err != nil {
					return result, err
				}
			} else {
				if j.NextProject == math.MaxUint32 {
					return result, errors.New("computer_storage_project_ids_exhausted")
				}
				if _, e := p.root.Lstat(base); !os.IsNotExist(e) {
					return result, errors.New("computer_media_unowned_data")
				}
				project = j.NextProject
			}
			// This operation writes real ISO bytes. Check only its unwritten bytes,
			// never the future logical growth of other guests.
			if quota > used && available < quota-used {
				return result, errors.New("computer_media_capacity_unavailable")
			}
			if previous == 0 {
				j.NextProject++
			}
			r = computerMediaRecord{Identity: i, ProjectID: project, QuotaBytes: quota, PreviousQuota: previous, Phase: "preparing"}
			if j.ComputerMedia == nil {
				j.ComputerMedia = map[string]computerMediaRecord{}
			}
			j.ComputerMedia[i.VolumeID] = r
			if err = p.write(j); err != nil {
				return result, err
			}
		}
		if r.Phase == "preparing" {
			for _, name := range []string{"installation-media", base} {
				if err = p.directory(name); err != nil {
					return result, err
				}
				if err = p.kernel.ownership(p.root, name, p.config.ClientUID, 0750); err != nil {
					return result, err
				}
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
			if _, err = k.resizeMediaQuota(mount, r.ProjectID, r.PreviousQuota, r.QuotaBytes, true); err != nil {
				return result, err
			}
			if err = p.directory(base + "/installer"); err != nil {
				return result, err
			}
			if err = p.kernel.ownership(p.root, base+"/installer", p.config.ClientUID, 0700); err != nil {
				return result, err
			}
			r.Phase, r.PreviousQuota = "ready", r.QuotaBytes
			j.ComputerMedia[i.VolumeID] = r
			if err = p.write(j); err != nil {
				return result, err
			}
		}
	}
	result = Result{Computer: &i, Media: true, ProjectID: r.ProjectID, QuotaBytes: r.QuotaBytes, Deleted: r.Phase == "deleted"}
	if q.Action == "computer-media-delete" && r.Phase != "deleted" {
		// Never recursively remove media. The Agent must first confirm the
		// optical drive no longer references it and remove its own exact files.
		if f, e := p.root.Open(base + "/installer"); e == nil {
			_, e = f.Readdirnames(1)
			f.Close()
			if e != io.EOF {
				return result, errors.New("computer_media_storage_in_use")
			}
		} else if !os.IsNotExist(e) {
			return result, e
		}
		r.Phase = "deleting"
		j.ComputerMedia[i.VolumeID] = r
		if err = p.write(j); err != nil {
			return result, err
		}
		for _, name := range []string{base + "/installer", base} {
			if err = p.root.Remove(name); err != nil && !os.IsNotExist(err) {
				return result, err
			}
		}
		if _, err = quotaKernel.computerQuota(mount, r.ProjectID, r.QuotaBytes, false, true); err != nil {
			return result, err
		}
		r.Phase = "deleted"
		j.ComputerMedia[i.VolumeID] = r
		if err = p.write(j); err != nil {
			return result, err
		}
		result.Deleted = true
		return result, nil
	}
	if r.Phase == "deleted" {
		return result, nil
	}
	if r.Phase != "ready" {
		return result, errors.New("computer_media_storage_pending")
	}
	for _, name := range []string{base, base + "/installer"} {
		info, e := p.root.Lstat(name)
		if e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return result, errors.New("computer_media_path_invalid")
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
	result.UsedBytes, err = k.resizeMediaQuota(mount, r.ProjectID, r.PreviousQuota, r.QuotaBytes, false)
	return result, err
}
