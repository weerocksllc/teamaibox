package phonepool

import (
	"context"
	"errors"
	"sort"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

// Observation contains only pool identity and capacity, never paths, keys or
// phone records. It is obtained from the same privileged verifier as allocation.
type Observation struct {
	PoolID         string `json:"poolId"`
	LUKSUUID       string `json:"luksUUID"`
	FilesystemUUID string `json:"filesystemUUID"`
	TotalBytes     uint64 `json:"totalBytes"`
	AvailableBytes uint64 `json:"availableBytes"`
	QuotaBytes     uint64 `json:"quotaBytes"`
	ReserveBytes   uint64 `json:"reserveBytes"`
	ObservedAt     string `json:"observedAt"`
}

type capacityKernel interface {
	capacity(Config) (uint64, uint64, error)
}
type VolumeUsage struct {
	VolumeID  string `json:"volumeId"`
	UsedBytes uint64 `json:"usedBytes"`
}
type ComputerPoolObservation struct {
	Observation
	ComputerOverheadBytes uint64        `json:"computerOverheadBytes"`
	Volumes               []VolumeUsage `json:"volumes"`
	MediaReservedBytes    uint64        `json:"mediaReservedBytes,omitempty"`
}

func (p *Pool) observeComputers() (ComputerPoolObservation, error) {
	var result ComputerPoolObservation
	var err error
	result.Observation, err = p.observe()
	if err != nil {
		return result, err
	}
	if p.config.ComputerOverheadBytes == 0 {
		return result, errors.New("computer_storage_not_configured")
	}
	k, ok := p.kernel.(computerQuotaKernel)
	if !ok {
		return result, errors.New("computer_storage_unavailable")
	}
	j, err := p.read()
	if err != nil {
		return result, err
	}
	mount, err := p.root.Open(".")
	if err != nil {
		return result, err
	}
	defer mount.Close()

	result.ComputerOverheadBytes = p.config.ComputerOverheadBytes
	result.Volumes = []VolumeUsage{}
	for id, r := range j.Volumes {
		if r.Phase == "deleted" {
			continue
		}
		used, e := p.kernel.quota(mount, r.ProjectID, false, false)
		if e != nil {
			return result, e
		}
		result.Volumes = append(result.Volumes, VolumeUsage{id, used})
	}
	for id, r := range j.Computers {
		if r.Phase == "deleted" {
			continue
		}
		used, e := k.computerQuota(mount, r.ProjectID, r.QuotaBytes, false, false)
		if e != nil {
			return result, e
		}
		result.Volumes = append(result.Volumes, VolumeUsage{id, used})
	}
	sort.Slice(result.Volumes, func(i, j int) bool { return result.Volumes[i].VolumeID < result.Volumes[j].VolumeID })
	return result, nil
}
func validComputerObservation(value *ComputerPoolObservation, poolID string) bool {
	if value == nil || !validObservation(&value.Observation, poolID) || value.ComputerOverheadBytes == 0 || value.ComputerOverheadBytes >= 1<<53 || value.Volumes == nil || value.MediaReservedBytes >= 1<<53 {
		return false
	}
	seen := map[string]bool{}
	for _, v := range value.Volumes {
		if !uuidID.MatchString(v.VolumeID) || seen[v.VolumeID] || v.UsedBytes >= 1<<53 {
			return false
		}
		seen[v.VolumeID] = true
	}
	return true
}
func (c Client) ObserveComputers(ctx context.Context, poolID string) (ComputerPoolObservation, error) {
	r, err := c.Handle(ctx, Request{Action: "computer-pool-status", Identity: agent.PhoneIdentity{PoolID: poolID}})
	if err != nil {
		return ComputerPoolObservation{}, err
	}
	return *r.ComputerPool, nil
}

func (p *Pool) observe() (Observation, error) {
	var empty Observation
	k, ok := p.kernel.(capacityKernel)
	if !ok {
		return empty, errors.New("phone_storage_unavailable")
	}
	total, available, err := k.capacity(p.config)
	if err != nil {
		return empty, err
	}
	if total <= marginBytes || available > total {
		return empty, errors.New("phone_storage_capacity_invalid")
	}
	return Observation{PoolID: p.config.PoolID, LUKSUUID: p.config.LUKSUUID,
		FilesystemUUID: p.config.FilesystemUUID, TotalBytes: total, AvailableBytes: available,
		QuotaBytes: 16 << 30, ReserveBytes: marginBytes, ObservedAt: time.Now().UTC().Format(time.RFC3339Nano)}, nil
}

func (c Client) Observe(ctx context.Context, poolID string) (Observation, error) {
	result, err := c.Handle(ctx, Request{Action: "pool-status", Identity: agent.PhoneIdentity{PoolID: poolID}})
	if err != nil {
		return Observation{}, err
	}
	return *result.Pool, nil
}

func validObservation(value *Observation, poolID string) bool {
	if value == nil || value.PoolID != poolID || !uuidID.MatchString(value.LUKSUUID) || !uuidID.MatchString(value.FilesystemUUID) ||
		value.TotalBytes <= marginBytes || value.AvailableBytes > value.TotalBytes || value.QuotaBytes != 16<<30 || value.ReserveBytes != marginBytes {
		return false
	}
	at, err := time.Parse(time.RFC3339Nano, value.ObservedAt)
	return err == nil && time.Since(at) >= -time.Second && time.Since(at) <= 10*time.Second
}
