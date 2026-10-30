package docker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"sync"

	"teamaibox.local/node-agent/internal/agent"
)

type InstalledComputerProfile struct {
	ComputerRuntimeProfile
	FirmwareDirectory, MediaDirectory string
	ManagedMedia                      bool // Installed runtime capability; never part of disk identity.
}
type ComputerResourcePolicy struct {
	ControlRoot          string
	Profiles             []InstalledComputerProfile
	CPUGroups            [][]int // Installed homogeneous CPU clusters; do not mix GB10 core types.
	KVMGroup             uint32
	ProvisionMemoryBytes int64
}

// Reuses the Agent's existing host sampler and local quota helper. PostgreSQL
// owns admission; this final host check prevents a stale reservation starting a
// guest under memory pressure. It never stops an office service to make room.
type InstalledComputerResources struct {
	mu                   sync.Mutex
	installationLifetime sync.RWMutex
	policy               ComputerResourcePolicy
	storage              *InstalledComputerStorage
	engine               *EngineRuntime
	memory               agent.PhoneMemorySource
	root                 *os.Root
	chown                func(string, int, int) error
}
type computerRunBinding struct {
	Version int                      `json:"version"`
	Command agent.ComputerCommand    `json:"command"`
	Binding ComputerContainerBinding `json:"binding"`
}

var _ ComputerResources = (*InstalledComputerResources)(nil)

func NewInstalledComputerResources(policy ComputerResourcePolicy, storage *InstalledComputerStorage, memory agent.PhoneMemorySource) (*InstalledComputerResources, error) {
	if storage == nil || memory == nil || !phonePrivateRoot(policy.ControlRoot) || len(policy.Profiles) == 0 || len(policy.CPUGroups) == 0 || policy.KVMGroup == 0 ||
		policy.ProvisionMemoryBytes <= 0 || policy.ProvisionMemoryBytes >= 1<<53 {
		return nil, errors.New("computer_resources_not_configured")
	}
	for path := policy.ControlRoot; path != "/"; path = filepath.Dir(path) {
		i, e := os.Lstat(path)
		if e != nil || !i.IsDir() || i.Mode()&os.ModeSymlink != 0 || i.Mode().Perm()&0022 != 0 && i.Mode()&os.ModeSticky == 0 {
			return nil, errors.New("computer_control_path_invalid")
		}
	}
	seen := map[int]bool{}
	for _, group := range policy.CPUGroups {
		if len(group) == 0 {
			return nil, errors.New("computer_cpu_policy_invalid")
		}
		for _, cpu := range group {
			if cpu < 0 || seen[cpu] {
				return nil, errors.New("computer_cpu_policy_invalid")
			}
			seen[cpu] = true
		}
	}
	profiles := map[string]bool{}
	for _, profile := range policy.Profiles {
		if profiles[profile.ProfileID] || !computerRuntimeProfileID.MatchString(profile.ProfileID) || !phonePrivateRoot(profile.FirmwareDirectory) || !phonePrivateRoot(profile.MediaDirectory) {
			return nil, errors.New("computer_profile_invalid")
		}
		profiles[profile.ProfileID] = true
	}
	// Snapshot caller-owned maps/slices; installed policy cannot mutate mid-run.
	raw, _ := json.Marshal(policy)
	var cloned ComputerResourcePolicy
	if json.Unmarshal(raw, &cloned) != nil {
		return nil, errors.New("computer_configuration_invalid")
	}
	policy = cloned
	root, err := os.OpenRoot(policy.ControlRoot)
	if err != nil {
		return nil, err
	}
	return &InstalledComputerResources{policy: policy, storage: storage, engine: storage.engine, memory: memory, root: root, chown: os.Chown}, nil
}
func (r *InstalledComputerResources) Close() error {
	r.installationLifetime.Lock()
	defer r.installationLifetime.Unlock()
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.root == nil {
		return nil
	}
	err := r.root.Close()
	r.root = nil
	return err
}
func (r *InstalledComputerResources) ComputerProtectionConfigured() bool {
	return r != nil && r.root != nil && r.memory != nil && r.storage != nil
}
func (r *InstalledComputerResources) profile(p agent.ComputerCommand) (InstalledComputerProfile, error) {
	if _, err := r.storage.identity(p); err != nil {
		return InstalledComputerProfile{}, err
	}
	for _, profile := range r.policy.Profiles {
		if profile.ProfileID == p.ProfileID {
			q := p
			if q.Run == nil {
				q.Generation = 0
			} // Deletion still verifies the immutable profile, not a running config.
			if _, err := buildComputerRuntimeConfig(q, profile.ComputerRuntimeProfile); err != nil {
				return profile, err
			}
			return profile, nil
		}
	}
	return InstalledComputerProfile{}, errors.New("computer_profile_unavailable")
}
func (r *InstalledComputerResources) directory(name string, mode os.FileMode) error {
	if err := r.root.MkdirAll(name, mode); err != nil {
		return err
	}
	for part := name; part != "."; part = filepath.Dir(part) {
		i, e := r.root.Lstat(part)
		if e != nil || !i.IsDir() || i.Mode()&os.ModeSymlink != 0 {
			return errors.New("computer_control_path_invalid")
		}
	}
	return nil
}

// Historical runs keep their original runtime recipe. A host-program update
// does not invalidate old shutdown/recovery/cleanup records. Every other field
// must still match the installed system and immutable on-disk configuration.
func (r *InstalledComputerResources) recordedProfile(p agent.ComputerCommand, base string, provision bool) (InstalledComputerProfile, error) {
	raw, err := phoneReadFile(r.root, base+"/config/config.json", 16384)
	var recorded computerRuntimeConfig
	if err != nil || phoneDecodeFile(raw, &recorded) != nil {
		return InstalledComputerProfile{}, errors.New("computer_runtime_config_mismatch")
	}
	q := p
	if provision {
		q.Generation = 0
		q.Run = nil
		q.RuntimeImage = recorded.RuntimeImage
	}
	if _, err := r.storage.identity(q); err != nil {
		return InstalledComputerProfile{}, err
	}
	for _, profile := range r.policy.Profiles {
		if profile.ProfileID != q.ProfileID {
			continue
		}
		profile.RuntimeImage = q.RuntimeImage
		wanted, e := buildComputerRuntimeConfig(q, profile.ComputerRuntimeProfile)
		if e != nil || !reflect.DeepEqual(wanted, recorded) {
			return profile, errors.New("computer_runtime_config_mismatch")
		}
		return profile, nil
	}
	return InstalledComputerProfile{}, errors.New("computer_profile_unavailable")
}
func (r *InstalledComputerResources) files(ctx context.Context, p agent.ComputerCommand, profile InstalledComputerProfile, base string) (ComputerContainerBinding, error) {
	b := ComputerContainerBinding{GuestDirectory: filepath.Join(r.storage.dataRoot, p.VolumeID, "guest"),
		ConfigDirectory: filepath.Join(r.policy.ControlRoot, base, "config"), ControlDirectory: filepath.Join(r.policy.ControlRoot, base, "control"),
		FirmwareDirectory: profile.FirmwareDirectory, MediaDirectory: profile.MediaDirectory, KVMGroup: r.policy.KVMGroup, ShutdownSeconds: profile.ShutdownSeconds}
	if profile.SchemaVersion == 2 || profile.ManagedMedia && p.Installation != nil {
		var err error
		b.InstallerDirectory, err = r.storage.EnsureInstallationDirectory(ctx, p)
		if err != nil {
			return b, err
		}
	}
	for _, dir := range []string{base, base + "/config", base + "/control"} {
		if err := r.directory(dir, 0700); err != nil {
			return b, err
		}
	}
	if err := WriteComputerRuntimeConfig(b.ConfigDirectory, p, profile.ComputerRuntimeProfile); err != nil {
		return b, err
	}
	if err := r.writeInstallationLaunch(p, profile, base); err != nil {
		return b, err
	}
	// Bind-mounted config contains no credentials. Runtime UID 10001 must be
	// able to traverse/read it; parent Agent journal is never mounted in guest.
	if err := r.root.Chmod(base+"/config", 0755); err != nil {
		return b, err
	}
	if err := r.root.Chmod(base+"/config/config.json", 0444); err != nil {
		return b, err
	}
	if err := r.chown(b.ControlDirectory, 10001, 10001); err != nil {
		return b, err
	}
	return b, nil
}
func (r *InstalledComputerResources) PrepareComputerData(ctx context.Context, p agent.ComputerCommand) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p.Run != nil || p.Generation != 0 {
		return errors.New("computer_provision_identity_mismatch")
	}
	profile, err := r.profile(p)
	if err != nil {
		return err
	}
	if _, err = r.storage.Prepare(ctx, p); err != nil {
		return err
	}
	b, err := r.files(ctx, p, profile, "prepare/"+p.ComputerID)
	if err != nil {
		return err
	}
	b.MemoryBytes = r.policy.ProvisionMemoryBytes
	b.KVMGroup = 0
	if err = r.engine.provisionComputer(ctx, p, b); err != nil {
		return err
	}
	return r.verifyData(ctx, p, profile)
}
func (r *InstalledComputerResources) verifyData(ctx context.Context, p agent.ComputerCommand, profile InstalledComputerProfile) error {
	v, err := r.storage.Inspect(ctx, p)
	if err != nil {
		return err
	}
	root, err := os.OpenRoot(v.GuestDirectory)
	if err != nil {
		return err
	}
	defer root.Close()
	raw, err := phoneReadFile(root, "identity.json", 16384)
	if err != nil {
		return err
	}
	var marker struct {
		Phase    string         `json:"phase"`
		Identity map[string]any `json:"identity"`
	}
	if phoneDecodeFile(raw, &marker) != nil || marker.Phase != "ready" {
		return errors.New("computer_storage_identity_invalid")
	}
	c, err := buildComputerRuntimeConfig(p, profile.ComputerRuntimeProfile)
	if err != nil {
		return err
	}
	blob, _ := json.Marshal(c)
	var wanted map[string]any
	_ = json.Unmarshal(blob, &wanted)
	for _, key := range []string{"runId", "generation", "runtimeImage", "shutdownSeconds"} {
		delete(wanted, key)
	}
	if c.SchemaVersion == 2 {
		delete(wanted, "mediaDigest")
		delete(wanted, "driverDigest")
	}
	if !reflect.DeepEqual(marker.Identity, wanted) {
		return errors.New("computer_storage_identity_invalid")
	}
	for _, name := range []string{"system.qcow2", "VARS.fd"} {
		i, e := root.Lstat(name)
		if e != nil || !i.Mode().IsRegular() || i.Size() == 0 {
			return errors.New("computer_storage_identity_invalid")
		}
	}
	if p.TPMID != nil {
		i, e := root.Lstat("tpm")
		if e != nil || !i.IsDir() || i.Mode()&os.ModeSymlink != 0 {
			return errors.New("computer_storage_identity_invalid")
		}
	}
	return nil
}
func (r *InstalledComputerResources) VerifyComputerData(ctx context.Context, p agent.ComputerCommand) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	profile, err := r.profile(p)
	if err != nil {
		return err
	}
	return r.verifyData(ctx, p, profile)
}
func sameComputerBindingCommand(a, b agent.ComputerCommand) bool {
	a.OperationID = b.OperationID
	if a.Run == nil || b.Run == nil {
		return false
	}
	x, y := *a.Run, *b.Run
	x.ContainerID = nil
	y.ContainerID = nil
	a.Run = &x
	b.Run = &y
	if b.Allocation == nil {
		b.Allocation = a.Allocation
	} // inspect/shutdown use the saved allocation.
	if b.Installation == nil {
		b.Installation = a.Installation
	} // Read-only inspection uses the saved launch intent.
	return reflect.DeepEqual(a, b)
}
func (r *InstalledComputerResources) readRun(p agent.ComputerCommand) (computerRunBinding, error) {
	var saved computerRunBinding
	if p.Run == nil || !managedWorkerID.MatchString(p.Run.ID) {
		return saved, errors.New("computer_run_required")
	}
	raw, err := phoneReadFile(r.root, "runs/"+p.Run.ID+"/binding.json", 32768)
	if err != nil {
		return saved, err
	}
	if phoneDecodeFile(raw, &saved) != nil || saved.Version != 1 || !sameComputerBindingCommand(saved.Command, p) {
		return saved, errors.New("computer_run_binding_mismatch")
	}
	profile, err := r.recordedProfile(p, "runs/"+p.Run.ID, false)
	if err != nil {
		return saved, err
	}
	w := saved.Binding
	installer := ""
	if profile.SchemaVersion == 2 || saved.Command.Installation != nil {
		installer = r.storage.installerDirectory(p)
	}
	base := filepath.Join(r.policy.ControlRoot, "runs", p.Run.ID)
	if w.GuestDirectory != filepath.Join(r.storage.dataRoot, p.VolumeID, "guest") || w.ConfigDirectory != filepath.Join(base, "config") || w.ControlDirectory != filepath.Join(base, "control") ||
		w.FirmwareDirectory != profile.FirmwareDirectory || w.MediaDirectory != profile.MediaDirectory || w.InstallerDirectory != installer || w.KVMGroup != r.policy.KVMGroup || w.ShutdownSeconds != profile.ShutdownSeconds ||
		saved.Command.Allocation == nil || w.MemoryBytes != saved.Command.Allocation.MemoryBytes || !reflect.DeepEqual(w.CPUIds, saved.Command.Allocation.CPUIds) {
		return saved, errors.New("computer_run_binding_mismatch")
	}
	check := w
	if check.NetworkID == "" {
		check.NetworkID = zeroComputerNetwork
	}
	if _, err = buildComputerContainer(p, check); err != nil {
		return saved, err
	}
	return saved, nil
}

const zeroComputerNetwork = "0000000000000000000000000000000000000000000000000000000000000000"

func (r *InstalledComputerResources) writeRun(b computerRunBinding) error {
	raw, err := json.Marshal(b)
	if err != nil {
		return err
	}
	return phoneWriteFile(r.root, "runs/"+b.Command.Run.ID+"/binding.json", raw)
}
func (r *InstalledComputerResources) admit(ctx context.Context, p agent.ComputerCommand) error {
	a := p.Allocation
	if a == nil || a.MemoryBytes <= p.Resources.MemoryBytes || a.MemoryBytes >= 1<<53 || int64(len(a.CPUIds)) != p.Resources.VCPUs {
		return errors.New("computer_allocation_required")
	}
	valid := false
	for _, group := range r.policy.CPUGroups {
		members := map[int]bool{}
		for _, cpu := range group {
			members[cpu] = true
		}
		seen := map[int]bool{}
		ok := true
		for _, cpu := range a.CPUIds {
			if !members[cpu] || seen[cpu] {
				ok = false
			}
			seen[cpu] = true
		}
		if ok {
			valid = true
		}
	}
	if !valid {
		return errors.New("computer_cpu_allocation_invalid")
	}
	return r.checkPreviousRun(ctx, p)
}

// Retain the same-computer run fence without claiming other guests' CPU/RAM.
func (r *InstalledComputerResources) checkPreviousRun(ctx context.Context, p agent.ComputerCommand) error {
	dir, err := r.root.Open("runs")
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer dir.Close()
	entries, err := dir.ReadDir(-1)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() == p.Run.ID {
			continue
		}
		if !entry.IsDir() || !managedWorkerID.MatchString(entry.Name()) {
			return errors.New("computer_run_binding_mismatch")
		}
		name := "runs/" + entry.Name() + "/binding.json"
		if _, err := r.root.Lstat(name); os.IsNotExist(err) {
			continue
		}
		raw, err := phoneReadFile(r.root, name, 32768)
		var saved computerRunBinding
		if err != nil || phoneDecodeFile(raw, &saved) != nil {
			return errors.New("computer_run_binding_mismatch")
		}
		if saved.Command.ComputerID != p.ComputerID {
			continue
		}
		saved, err = r.readRun(saved.Command)
		if err != nil {
			return err
		}
		if saved.Binding.NetworkID == "" {
			return errors.New("computer_previous_run_not_stopped")
		}
		state, exists, err := r.engine.inspectComputerContainer(ctx, saved.Command, saved.Binding)
		if err != nil {
			return err
		}
		if exists && state.State.Running {
			return errors.New("computer_previous_run_not_stopped")
		}
		if exists && state.State.Status != "exited" {
			return errors.New("computer_previous_run_not_stopped")
		}
		if err := r.releaseComputerNetwork(ctx, saved); err != nil {
			return err
		}
	}
	return nil
}
func (r *InstalledComputerResources) BindComputerRun(ctx context.Context, p agent.ComputerCommand) (ComputerContainerBinding, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var empty ComputerContainerBinding
	profile, err := r.profile(p)
	if err != nil {
		return empty, err
	}
	if p.Run == nil {
		return empty, errors.New("computer_run_required")
	}
	if err = r.verifyData(ctx, p, profile); err != nil {
		return empty, err
	}
	base := "runs/" + p.Run.ID
	var saved computerRunBinding
	if _, e := r.root.Lstat(base + "/binding.json"); e == nil {
		saved, err = r.readRun(p)
		if err != nil {
			return empty, err
		}
		if saved.Binding.NetworkID != "" {
			s, exists, e := r.engine.inspectComputerContainer(ctx, p, saved.Binding)
			if e != nil {
				return empty, e
			}
			if exists && s.State.Status != "created" {
				return saved.Binding, nil
			} // Driver never revives an exited run.
		}
	} else if !os.IsNotExist(e) {
		return empty, e
	}
	if err = r.admit(ctx, p); err != nil {
		return empty, err
	}
	if saved.Version == 0 {
		b, e := r.files(ctx, p, profile, base)
		if e != nil {
			return empty, e
		}
		b.CPUIds = append([]int(nil), p.Allocation.CPUIds...)
		b.MemoryBytes = p.Allocation.MemoryBytes
		saved = computerRunBinding{Version: 1, Command: p, Binding: b}
		if err = r.writeRun(saved); err != nil {
			return empty, err
		}
	}
	network, err := r.computerNetwork(ctx, saved, true)
	if err != nil {
		return empty, err
	}
	if saved.Binding.NetworkID == "" {
		saved.Binding.NetworkID = network
		if err = r.writeRun(saved); err != nil {
			return empty, err
		}
	}
	return saved.Binding, nil
}
func (r *InstalledComputerResources) ResolveComputerRun(ctx context.Context, p agent.ComputerCommand) (ComputerContainerBinding, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	saved, err := r.readRun(p)
	if err != nil {
		return saved.Binding, err
	}
	if _, err = r.computerNetwork(ctx, saved, false); err != nil {
		var missing *engineStatusError
		if errors.As(err, &missing) && missing.status == http.StatusNotFound {
			// A completed run keeps its original container and disk, but no
			// longer consumes a subnet. A missing network is never accepted
			// for a running, created or absent container.
			state, exists, inspectErr := r.engine.inspectComputerContainer(ctx, saved.Command, saved.Binding)
			if inspectErr == nil && exists && !state.State.Running && state.State.Status == "exited" {
				return saved.Binding, nil
			}
		}
		return saved.Binding, err
	}
	return saved.Binding, nil
}

// ReleaseComputerRun reclaims only the network of an exactly identified exited
// runtime. Retaining the container permits shutdown retries and preserves the
// runtime result; persistent disks, firmware and TPM state are untouched.
func (r *InstalledComputerResources) ReleaseComputerRun(ctx context.Context, p agent.ComputerCommand) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	saved, err := r.readRun(p)
	if err != nil {
		return err
	}
	return r.releaseComputerNetwork(ctx, saved)
}

func (r *InstalledComputerResources) releaseComputerNetwork(ctx context.Context, saved computerRunBinding) error {
	state, exists, err := r.engine.inspectComputerContainer(ctx, saved.Command, saved.Binding)
	if err != nil {
		return err
	}
	if !exists || state.State.Running || state.State.Status != "exited" {
		return errors.New("computer_storage_in_use")
	}
	id, err := r.computerNetwork(ctx, saved, false)
	var missing *engineStatusError
	if errors.As(err, &missing) && missing.status == http.StatusNotFound {
		return nil
	}
	if err != nil {
		return err
	}
	var network phoneNetworkState
	if err = r.engine.request(ctx, http.MethodGet, "/networks/"+id, nil, &network, http.StatusOK); err != nil {
		return err
	}
	if len(network.Containers) != 0 {
		return errors.New("computer_storage_in_use")
	}
	return r.engine.request(ctx, http.MethodDelete, "/networks/"+id, nil, nil, http.StatusNoContent, http.StatusNotFound)
}

func (r *InstalledComputerResources) ReadComputerStatus(ctx context.Context, p agent.ComputerCommand) (ComputerRuntimeStatus, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var status ComputerRuntimeStatus
	if err := ctx.Err(); err != nil {
		return status, err
	}
	if _, err := r.readRun(p); err != nil {
		return status, err
	}
	raw, err := phoneReadFile(r.root, "runs/"+p.Run.ID+"/control/status.json", 16384)
	if err != nil {
		return status, err
	}
	if phoneDecodeFile(raw, &status) != nil || !status.matches(p) {
		return status, errors.New("computer_runtime_status_unavailable")
	}
	return status, nil
}
func (r *InstalledComputerResources) RequestComputerShutdown(ctx context.Context, p agent.ComputerCommand) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, err := r.readRun(p); err != nil {
		return err
	}
	raw, _ := json.Marshal(map[string]any{"computerId": p.ComputerID, "runId": p.Run.ID, "generation": p.Generation})
	name := "runs/" + p.Run.ID + "/control/shutdown.json"
	if err := phoneWriteFile(r.root, name, raw); err != nil {
		return err
	}
	return r.root.Chmod(name, 0644) // root-created request must be readable by the non-root runtime.
}
func (r *InstalledComputerResources) DeleteComputerData(ctx context.Context, p agent.ComputerCommand) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	profile, err := r.recordedProfile(p, "prepare/"+p.ComputerID, true)
	if err != nil {
		return err
	}
	if err := r.cleanupStoppedComputer(ctx, p); err != nil {
		return err
	}
	if profile.SchemaVersion == 2 || profile.ManagedMedia {
		if err := r.storage.deleteInstallationStaging(ctx, p); err != nil {
			return err
		}
	}
	_, err = r.storage.Delete(ctx, p)
	return err
}
func (r *InstalledComputerResources) VerifyComputerDeleted(ctx context.Context, p agent.ComputerCommand) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.storage.VerifyDeleted(ctx, p)
}

// Delete only stopped containers whose complete installed recipe still matches.
// There is deliberately no Docker stop/kill or force-network-removal here.
func (r *InstalledComputerResources) cleanupStoppedComputer(ctx context.Context, p agent.ComputerCommand) error {
	filters, _ := json.Marshal(map[string][]string{"label": {"com.teamaibox.volume-id=" + p.VolumeID}})
	var containers []struct {
		ID string `json:"Id"`
	}
	if err := r.engine.request(ctx, http.MethodGet, "/containers/json?all=1&filters="+url.QueryEscape(string(filters)), nil, &containers, http.StatusOK); err != nil {
		return err
	}
	networks := map[string]bool{}
	ownedRuns := map[string]bool{}
	for _, container := range containers {
		if !phoneExactContainerID.MatchString(container.ID) {
			return errors.New("computer_container_identity_mismatch")
		}
		var state phoneEngineState
		if err := r.engine.request(ctx, http.MethodGet, "/containers/"+container.ID+"/json", nil, &state, http.StatusOK); err != nil {
			return err
		}
		if state.ID != container.ID || state.State.Running || state.State.Status != "exited" && state.State.Status != "created" {
			return errors.New("computer_storage_in_use")
		}
		labels, ok := state.Config["Labels"].(map[string]any)
		if !ok {
			return errors.New("computer_container_identity_mismatch")
		}
		q := p
		if operation, ok := labels["com.teamaibox.provision-id"].(string); ok {
			q.OperationID = operation
			q.Generation = 0
			q.Run = nil
			q.Allocation = nil
			profile, e := r.recordedProfile(q, "prepare/"+q.ComputerID, true)
			if e != nil {
				return e
			}
			q.RuntimeImage = profile.RuntimeImage
			base := filepath.Join(r.policy.ControlRoot, "prepare", q.ComputerID)
			b := ComputerContainerBinding{GuestDirectory: filepath.Join(r.storage.dataRoot, q.VolumeID, "guest"), ConfigDirectory: filepath.Join(base, "config"), ControlDirectory: filepath.Join(base, "control"), FirmwareDirectory: profile.FirmwareDirectory, MediaDirectory: profile.MediaDirectory, MemoryBytes: r.policy.ProvisionMemoryBytes, ShutdownSeconds: profile.ShutdownSeconds}
			if profile.SchemaVersion == 2 {
				b.InstallerDirectory = r.storage.installerDirectory(q)
			}
			spec, e := buildComputerProvisionContainer(q, b)
			if e != nil || !exactComputerSpec(state, spec) {
				return errors.New("computer_container_identity_mismatch")
			}
		} else {
			run, ok := labels["com.teamaibox.computer-run-id"].(string)
			if !ok || !managedWorkerID.MatchString(run) {
				return errors.New("computer_container_identity_mismatch")
			}
			raw, e := phoneReadFile(r.root, "runs/"+run+"/binding.json", 32768)
			var saved computerRunBinding
			if e != nil || phoneDecodeFile(raw, &saved) != nil {
				return errors.New("computer_run_binding_mismatch")
			}
			if saved.Command.ComputerID != p.ComputerID || saved.Command.VolumeID != p.VolumeID || saved.Command.OwnerID != p.OwnerID {
				return errors.New("computer_container_identity_mismatch")
			}
			saved, e = r.readRun(saved.Command)
			if e != nil {
				return e
			}
			if !exactComputerContainer(state, saved.Command, saved.Binding) {
				return errors.New("computer_container_identity_mismatch")
			}
			networks[saved.Binding.NetworkID] = true
			ownedRuns[run] = true
		}
		if err := r.engine.request(ctx, http.MethodDelete, "/containers/"+container.ID, nil, nil, http.StatusNoContent); err != nil {
			return err
		}
	}
	// Include a network left by a lost create reply or an interrupted deletion.
	dir, e := r.root.Open("runs")
	if e != nil && !os.IsNotExist(e) {
		return e
	}
	if e == nil {
		defer dir.Close()
		entries, e := dir.ReadDir(-1)
		if e != nil {
			return e
		}
		for _, entry := range entries {
			if !entry.IsDir() || !managedWorkerID.MatchString(entry.Name()) {
				return errors.New("computer_run_binding_mismatch")
			}
			raw, e := phoneReadFile(r.root, "runs/"+entry.Name()+"/binding.json", 32768)
			if e != nil {
				if _, missing := r.root.Lstat("runs/" + entry.Name() + "/binding.json"); os.IsNotExist(missing) {
					continue
				}
				return e
			}
			var saved computerRunBinding
			if phoneDecodeFile(raw, &saved) != nil {
				return errors.New("computer_run_binding_mismatch")
			}
			if saved.Command.ComputerID != p.ComputerID {
				continue
			}
			if saved.Command.OwnerID != p.OwnerID || saved.Command.VolumeID != p.VolumeID {
				return errors.New("computer_container_identity_mismatch")
			}
			saved, e = r.readRun(saved.Command)
			if e != nil {
				return e
			}
			ownedRuns[entry.Name()] = true
			id, e := r.computerNetwork(ctx, saved, false)
			var missing *engineStatusError
			if errors.As(e, &missing) && missing.status == http.StatusNotFound {
				continue
			}
			if e != nil {
				return e
			}
			networks[id] = true
		}
	}
	for id := range networks {
		if err := r.engine.request(ctx, http.MethodDelete, "/networks/"+id, nil, nil, http.StatusNoContent, http.StatusNotFound); err != nil {
			return err
		}
	}
	// Run bindings are admission records, not an audit archive. Keeping an
	// exactly-owned binding after its container and network have been removed
	// makes the next guest falsely collide with the deleted guest's CPU set.
	// Remove only bindings whose immutable computer, owner and volume identities
	// were verified above, after their runtime resources are gone.
	for run := range ownedRuns {
		if err := r.root.RemoveAll("runs/" + run); err != nil {
			return err
		}
	}
	if len(ownedRuns) > 0 {
		if err := syncDirectory(filepath.Join(r.policy.ControlRoot, "runs")); err != nil {
			return err
		}
	}
	return nil
}

func (r *InstalledComputerResources) computerNetwork(ctx context.Context, b computerRunBinding, create bool) (string, error) {
	p := b.Command
	name := "teamaibox-computer-" + p.Run.ID
	labels := map[string]string{"com.teamaibox.kind": "windows-computer", "com.teamaibox.node-id": p.NodeID, "com.teamaibox.computer-id": p.ComputerID, "com.teamaibox.computer-run-id": p.Run.ID, "com.teamaibox.owner-identity-id": p.OwnerID}
	id := b.Binding.NetworkID
	if id == "" {
		id = name
	}
	var state phoneNetworkState
	err := r.engine.request(ctx, http.MethodGet, "/networks/"+url.PathEscape(id), nil, &state, http.StatusOK)
	var status *engineStatusError
	if errors.As(err, &status) && status.status == http.StatusNotFound && create && b.Binding.NetworkID == "" {
		var result struct {
			ID string `json:"Id"`
		}
		if err = r.engine.request(ctx, http.MethodPost, "/networks/create", map[string]any{"Name": name, "Driver": "bridge", "Internal": false, "EnableIPv6": false, "CheckDuplicate": true, "Labels": labels, "Options": phoneNetworkOptions()}, &result, http.StatusCreated); err != nil {
			return "", err
		}
		if !phoneExactContainerID.MatchString(result.ID) {
			return "", errors.New("computer_network_identity_mismatch")
		}
		b.Binding.NetworkID = result.ID
		return r.computerNetwork(ctx, b, false)
	}
	if err != nil {
		return "", err
	}
	if !phoneExactContainerID.MatchString(state.ID) || b.Binding.NetworkID != "" && state.ID != b.Binding.NetworkID || state.Name != name || state.Driver != "bridge" || state.Scope != "local" || state.Internal || state.EnableIPv6 || !reflect.DeepEqual(state.Labels, labels) || !reflect.DeepEqual(state.Options, phoneNetworkOptions()) || len(state.Containers) > 1 {
		return "", errors.New("computer_network_identity_mismatch")
	}
	for id := range state.Containers {
		binding := b.Binding
		binding.NetworkID = state.ID
		s, exists, e := r.engine.inspectComputerContainer(ctx, p, binding)
		if e != nil || !exists || s.ID != id {
			return "", errors.New("computer_network_identity_mismatch")
		}
	}
	return state.ID, nil
}
