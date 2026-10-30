package docker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"time"

	"teamaibox.local/node-agent/internal/agent"
	"teamaibox.local/node-agent/internal/phonepool"
)

func (d *ComputerDriver) ComputerBaseline(ctx context.Context) (json.RawMessage, error) {
	provider, ok := d.resources.(agent.ComputerBaselineProvider)
	if !ok {
		return nil, errors.New("computer_baseline_unavailable")
	}
	return provider.ComputerBaseline(ctx)
}
func (r *InstalledComputerResources) ComputerBaseline(ctx context.Context) (json.RawMessage, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	samples, err := r.memory.PhoneMemorySamples(ctx)
	if err != nil {
		return nil, err
	}
	assessment, err := agent.AssessPhoneMemory(samples, time.Now())
	if err != nil {
		return nil, err
	}
	result, err := r.storage.storage.Handle(ctx, phonepool.Request{Action: "computer-pool-status", Identity: agent.PhoneIdentity{PoolID: r.storage.poolID}})
	if err != nil {
		return nil, err
	}
	pool := result.ComputerPool
	if pool == nil || pool.PoolID != r.storage.poolID || pool.ComputerOverheadBytes == 0 {
		return nil, errors.New("computer_storage_unavailable")
	}
	observed, err := time.Parse(time.RFC3339Nano, pool.ObservedAt)
	if err != nil || time.Since(observed) > 10*time.Second || time.Until(observed) > time.Second {
		return nil, errors.New("computer_storage_unavailable")
	}
	workers := []map[string]any{}
	filters, _ := json.Marshal(map[string][]string{"label": {"com.teamaibox.kind=windows-computer", "com.teamaibox.node-id=" + r.storage.nodeID}})
	var containers []struct {
		ID     string            `json:"Id"`
		Labels map[string]string `json:"Labels"`
	}
	if err = r.engine.request(ctx, http.MethodGet, "/containers/json?filters="+url.QueryEscape(string(filters)), nil, &containers, http.StatusOK); err != nil {
		return nil, err
	}
	for _, container := range containers {
		run := container.Labels["com.teamaibox.computer-run-id"]
		if run == "" {
			continue
		}
		if !managedWorkerID.MatchString(run) {
			return nil, errors.New("computer_runtime_identity_mismatch")
		}
		raw, e := phoneReadFile(r.root, "runs/"+run+"/binding.json", 32768)
		var saved computerRunBinding
		if e != nil || phoneDecodeFile(raw, &saved) != nil {
			return nil, errors.New("computer_run_binding_mismatch")
		}
		saved, e = r.readRun(saved.Command)
		if e != nil {
			return nil, e
		}
		state, exists, e := r.engine.inspectComputerContainer(ctx, saved.Command, saved.Binding)
		if e != nil || !exists || state.ID != container.ID || !state.State.Running {
			return nil, errors.New("computer_runtime_identity_mismatch")
		}
		var stats struct {
			Memory struct {
				Usage uint64            `json:"usage"`
				Stats map[string]uint64 `json:"stats"`
			} `json:"memory_stats"`
		}
		if e = r.engine.request(ctx, http.MethodGet, "/containers/"+state.ID+"/stats?stream=false&one-shot=true", nil, &stats, http.StatusOK); e != nil {
			return nil, e
		}
		used := stats.Memory.Usage
		cache := stats.Memory.Stats["inactive_file"]
		if legacy := stats.Memory.Stats["total_inactive_file"]; legacy > cache {
			cache = legacy
		}
		if used > cache {
			used -= cache
		} else {
			used = 0
		}
		workers = append(workers, map[string]any{"workerId": run, "cgroup": map[string]any{"currentBytes": used}, "stale": false})
	}
	last, _ := time.Parse(time.RFC3339Nano, samples[len(samples)-1].ObservedAt)
	cpus := 0
	for _, group := range r.policy.CPUGroups {
		cpus += len(group)
	}
	profiles := []map[string]any{}
	for _, p := range r.policy.Profiles {
		var media, driver any = p.MediaDigest, p.DriverDigest
		if p.SchemaVersion == 2 {
			if p.MediaDigest == "" {
				media = nil
			}
			if p.DriverDigest == "" {
				driver = nil
			}
		}
		profiles = append(profiles, map[string]any{"id": p.ProfileID, "runtimeImage": p.RuntimeImage,
			"firmwareDigest": p.FirmwareCodeDigest, "mediaDigest": media, "driverDigest": driver, "tpm": p.TPMRequired})
	}

	return json.Marshal(map[string]any{"poolId": pool.PoolID, "encryption": "luks2", "sampledAt": last.UnixMilli(), "volumes": pool.Volumes,
		"freeStorageBytes": pool.AvailableBytes, "storageOverheadBytes": pool.ComputerOverheadBytes, "storageReserveBytes": pool.ReserveBytes,
		"memoryAvailableBytes": assessment.MinimumAvailableBytes, "freeCpuCount": cpus, "kvm": true, "memoryPressure": !assessment.AdmissionQuiet,
		"swapOutActive": samples[0].SwapOutBytes != samples[len(samples)-1].SwapOutBytes, "availableCpuGroups": r.policy.CPUGroups, "workers": workers, "installedProfiles": profiles})
}
