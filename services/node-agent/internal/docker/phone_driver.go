package docker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

// This port belongs to the installed encrypted storage/private network adapter.
// BindRun is idempotent for the exact run and writes only its fixed declaration
// and short-lived certificate. ResolveRun is read-only and cannot create them.
// No implementation or permissive fallback is supplied by the public API.
type PhoneResources interface {
	PrepareData(context.Context, agent.PhoneCommandPayload) error
	BindRun(context.Context, agent.PhoneCommandPayload) (PhoneResourceBinding, error)
	ResolveRun(context.Context, agent.PhoneCommandPayload) (PhoneResourceBinding, error)
	ReadStatus(context.Context, agent.PhoneCommandPayload) (PhoneRuntimeStatus, error)
	ReleaseRun(context.Context, agent.PhoneCommandPayload) error
	CancelUnstartedRun(context.Context, agent.PhoneCommandPayload) (bool, error)
	DeleteData(context.Context, agent.PhoneCommandPayload) error
}

type PhoneResourceBinding struct {
	Identity              agent.PhoneIdentity
	RunID                 string
	Generation            uint64
	NetworkID             string
	QuotaBytes            int64
	Instance              int
	NodeGeneration        int64 // Immutable origin of this exact runtime, not command authority.
	RetiredNodeGeneration int64 // Only populated by released-history resolution.
}

type PhoneRuntimeStatus struct {
	PhoneID             string  `json:"phoneId"`
	OwnerID             string  `json:"ownerId"`
	VolumeID            string  `json:"volumeId"`
	RunID               string  `json:"runId"`
	Generation          uint64  `json:"generation"`
	BuildID             string  `json:"buildId"`
	Phase               string  `json:"phase"`
	AndroidReady        bool    `json:"androidReady"`
	MediaReady          bool    `json:"mediaReady"`
	CleanShutdown       bool    `json:"cleanShutdown"`
	ErrorCode           *string `json:"errorCode"`
	UpdatedAtUnixMs     int64   `json:"updatedAtUnixMs"`
	ShutdownDiagnostics *struct {
		Before                 []phoneShutdownProcess `json:"before"`
		After                  []phoneShutdownProcess `json:"after"`
		RequestExitCode        int                    `json:"requestExitCode"`
		RequestReportedFailure bool                   `json:"requestReportedFailure"`
		RuntimeCleanup         []struct {
			Attempt                 int    `json:"attempt"`
			ExitCode                *int   `json:"exitCode,omitempty"`
			RemainingGuestProcesses *int   `json:"remainingGuestProcesses,omitempty"`
			Error                   string `json:"error,omitempty"`
			Errno                   *int   `json:"errno,omitempty"`
		} `json:"runtimeCleanup,omitempty"`
	} `json:"shutdownDiagnostics,omitempty"`
	ShutdownEvidence struct {
		SyncCompleted                bool `json:"syncCompleted"`
		AndroidShutdownRequested     bool `json:"androidShutdownRequested"`
		GuestExitedBeforeRuntimeStop bool `json:"guestExitedBeforeRuntimeStop"`
	} `json:"shutdownEvidence"`
}

type phoneShutdownProcess struct {
	PID            int      `json:"pid"`
	Role           string   `json:"role"`
	ParentRole     string   `json:"parentRole"`
	ControlSockets []string `json:"controlSockets"`
	CIDs           []int    `json:"cids"`
}

func (s PhoneRuntimeStatus) matches(p agent.PhoneCommandPayload) bool {
	return p.Run != nil && s.PhoneID == p.PhoneID && s.OwnerID == p.OwnerID && s.VolumeID == p.VolumeID &&
		s.RunID == p.Run.ID && s.Generation == p.Generation && s.BuildID == p.BaseBuildID
}

type PhoneDriver struct {
	engine               *EngineRuntime
	policy               PhoneContainerPolicy
	resources            PhoneResources
	now                  func() time.Time
	networkRolesMu       sync.Mutex
	networkRolesVerified map[string]string
}

var _ agent.PhoneDriver = (*PhoneDriver)(nil)

func NewPhoneDriver(engine *EngineRuntime, policy PhoneContainerPolicy, resources PhoneResources) (*PhoneDriver, error) {
	if engine == nil || resources == nil || !phonePrivateRoot(policy.DataRoot) || !phonePrivateRoot(policy.ControlRoot) ||
		!managedWorkerID.MatchString(policy.NodeID) || !validPhoneNetworkPolicy(policy) || !agent.ValidInstalledPhoneImages(policy.ImageID, policy.AdditionalImageDigests, policy.RetiredImageDigests) {
		return nil, errors.New("phone_driver_not_configured")
	}
	return &PhoneDriver{engine: engine, policy: policy, resources: resources, now: time.Now}, nil
}

func phoneResult(p agent.PhoneCommandPayload) agent.PhoneCommandResult {
	result := agent.PhoneCommandResult{PhoneIdentity: p.PhoneIdentity, OperationID: p.OperationID, Generation: p.Generation}
	if p.Run != nil {
		result.RunID = p.Run.ID
	}
	return result
}

func (d *PhoneDriver) validateBinding(p agent.PhoneCommandPayload, b PhoneResourceBinding) error {
	if p.Run == nil || b.Identity != p.PhoneIdentity || b.RunID != p.Run.ID || b.Generation != p.Generation || b.QuotaBytes != agent.PhoneStorageBytes || b.NodeGeneration < 0 || b.NodeGeneration > d.policy.NodeGeneration {
		return errors.New("phone_storage_binding_mismatch")
	}
	_, err := buildPhoneContainer(d.policy.forBinding(b), p, b.NetworkID)
	return err
}

func (d *PhoneDriver) PreparePhoneData(ctx context.Context, p agent.PhoneCommandPayload) (agent.PhoneCommandResult, error) {
	result := phoneResult(p)
	if p.Run != nil || p.Generation != 0 || p.PoolID != d.policy.PoolID {
		return result, errors.New("phone_storage_binding_mismatch")
	}
	if err := d.resources.PrepareData(ctx, p); err != nil {
		return result, err
	}
	result.StorageReady = true
	result.RuntimeStopped = true
	return result, nil
}

func (d *PhoneDriver) inspect(ctx context.Context, p agent.PhoneCommandPayload, b PhoneResourceBinding) (agent.PhoneCommandResult, error) {
	result := phoneResult(p)
	if err := d.validateBinding(p, b); err != nil {
		return result, err
	}
	container, exists, err := d.engine.inspectPhoneContainer(ctx, d.policy.forBinding(b), p, b.NetworkID)
	if err != nil {
		return result, err
	}
	if !exists {
		return result, errors.New("phone_stop_unconfirmed")
	}
	result.StorageReady = true
	result.ContainerID = container.ID
	result.RuntimeStopped = !container.State.Running && (container.State.Status == "exited" || container.State.Status == "created")
	status, err := d.resources.ReadStatus(ctx, p)
	if err != nil || !status.matches(p) {
		if result.RuntimeStopped {
			return result, nil
		} // Known stopped, but cannot claim a clean shutdown.
		return result, errors.New("phone_runtime_status_unavailable")
	}
	if result.RuntimeStopped {
		proof := status.ShutdownEvidence
		result.CleanShutdown = container.State.ExitCode == 0 && !container.State.OOMKilled && status.Phase == "stopped" &&
			status.CleanShutdown && status.ErrorCode == nil && proof.SyncCompleted && proof.AndroidShutdownRequested && proof.GuestExitedBeforeRuntimeStop
		return result, nil
	}
	age := d.now().UnixMilli() - status.UpdatedAtUnixMs
	// Boot may legitimately take longer than one heartbeat window. The start
	// deadline bounds it; only a published ready/unavailable state is a lease.
	if age < 0 || (age > 30000 && status.Phase != "starting") {
		return result, errors.New("phone_runtime_status_stale")
	}
	if status.Phase == "running" && status.ErrorCode == nil {
		result.AndroidReady = status.AndroidReady
		result.MediaReady = status.MediaReady
	}
	return result, nil
}

func (d *PhoneDriver) StartPhone(ctx context.Context, p agent.PhoneCommandPayload) (agent.PhoneCommandResult, error) {
	result := phoneResult(p)
	binding, err := d.resources.BindRun(ctx, p)
	if err != nil {
		return result, err
	}
	if err = d.validateBinding(p, binding); err != nil {
		return result, err
	}
	if binding.NodeGeneration > 0 && binding.NodeGeneration < d.policy.NodeGeneration {
		// An old run is only reattached, never restarted or re-created.
		return d.inspect(ctx, p, binding)
	}
	if _, err = d.engine.startPhoneContainer(ctx, d.policy.forInstance(binding.Instance), p, binding.NetworkID); err != nil {
		return result, err
	}
	timer := time.NewTimer(0)
	defer timer.Stop()
	deadline := time.NewTimer(5 * time.Minute)
	defer deadline.Stop()
	for {
		select {
		case <-ctx.Done():
			return result, ctx.Err() // Do not release a possibly live reservation.
		case <-deadline.C:
			return result, errors.New("phone_readiness_timeout")
		case <-timer.C:
			result, err = d.inspect(ctx, p, binding)
			if err == nil && result.AndroidReady && result.MediaReady {
				container, exists, inspectionErr := d.engine.inspectPhoneContainer(ctx, d.policy.forBinding(binding), p, binding.NetworkID)
				if inspectionErr != nil || !exists {
					return result, errors.New("phone_network_role_identity_mismatch")
				}
				if err = d.ensurePhoneNetworkRoles(ctx, container, binding); err != nil {
					return result, err
				}
				return result, nil
			}
			if err == nil && result.RuntimeStopped {
				return result, errors.New("phone_runtime_exited")
			}
			if err != nil && err.Error() != "phone_runtime_status_unavailable" {
				return result, err
			}
			timer.Reset(time.Second)
		}
	}
}

func (d *PhoneDriver) InspectPhone(ctx context.Context, p agent.PhoneCommandPayload) (agent.PhoneCommandResult, error) {
	b, err := d.resources.ResolveRun(ctx, p)
	if err != nil {
		return phoneResult(p), err
	}
	return d.inspect(ctx, p, b)
}

func (d *PhoneDriver) StopPhone(ctx context.Context, p agent.PhoneCommandPayload) (agent.PhoneCommandResult, error) {
	result := phoneResult(p)
	if cancelled, err := d.resources.CancelUnstartedRun(ctx, p); err != nil || cancelled {
		result.RuntimeStopped = cancelled
		return result, err // No VM booted: do not claim an Android clean shutdown.
	}
	b, err := d.resources.ResolveRun(ctx, p)
	if err != nil {
		return result, err
	}
	if err = d.validateBinding(p, b); err != nil {
		return result, err
	}
	if _, err = d.engine.stopPhoneContainer(ctx, d.policy.forBinding(b), p, b.NetworkID); err != nil {
		return result, err
	}
	// Keep the exact exit for retries, but release its instance/vsock slot only
	// after the adapter has independently confirmed that the container stopped.
	result, err = d.inspect(ctx, p, b)
	if err != nil || !result.RuntimeStopped {
		return result, err
	}
	if err = d.resources.ReleaseRun(ctx, p); err != nil {
		return result, err
	}
	return result, nil
}

func (d *PhoneDriver) DeletePhoneData(ctx context.Context, p agent.PhoneCommandPayload) (agent.PhoneCommandResult, error) {
	result := phoneResult(p)
	if p.Run != nil || p.PoolID != d.policy.PoolID || !managedWorkerID.MatchString(p.VolumeID) {
		return result, errors.New("phone_storage_binding_mismatch")
	}
	filter, _ := json.Marshal(map[string][]string{"label": {"com.teamaibox.kind=android-phone", "com.teamaibox.volume-id=" + p.VolumeID}})
	var listed []struct {
		ID string `json:"Id"`
	}
	if err := d.engine.request(ctx, http.MethodGet, "/containers/json?all=1&filters="+url.QueryEscape(string(filter)), nil, &listed, http.StatusOK); err != nil {
		return result, err
	}
	type retired struct {
		request  agent.PhoneCommandPayload
		network  string
		instance int
		policy   PhoneContainerPolicy
	}
	retire := []retired{}
	// Resolve and verify every old run before deleting any container or data.
	for _, item := range listed {
		if !phoneExactContainerID.MatchString(item.ID) {
			return result, errors.New("phone_container_identity_mismatch")
		}
		var state phoneEngineState
		if err := d.engine.request(ctx, http.MethodGet, "/containers/"+item.ID+"/json", nil, &state, http.StatusOK); err != nil {
			return result, err
		}
		labels, ok := state.Config["Labels"].(map[string]any)
		if !ok {
			return result, errors.New("phone_container_identity_mismatch")
		}
		text := func(key string) string { value, _ := labels[key].(string); return value }
		generation, err := strconv.ParseUint(text("com.teamaibox.phone-generation"), 10, 64)
		if err != nil || generation > p.Generation {
			return result, errors.New("phone_stale_run")
		}
		old := p
		old.Generation = generation
		old.Run = &agent.PhoneRunIdentity{ID: text("com.teamaibox.phone-run-id"), ReservationID: text("com.teamaibox.reservation-id"), ImageDigest: state.Image, MemoryBytes: agent.PhoneMemoryBytes, CPUMillis: agent.PhoneCPUMillis}
		historyPolicy, err := d.policy.forRetiredImage(state.Image)
		if err != nil {
			return result, err
		}
		historicalGeneration, err := strconv.ParseInt(text("com.teamaibox.node-generation"), 10, 64)
		if err != nil || historicalGeneration < 1 || historicalGeneration > d.policy.NodeGeneration {
			return result, errors.New("phone_stale_run")
		}
		historyPolicy.NodeGeneration = historicalGeneration
		historical := state.Image != d.policy.ImageID || historicalGeneration != d.policy.NodeGeneration
		network, _ := state.HostConfig["NetworkMode"].(string)
		instance := 0
		if d.policy.NetworkProfile != "" || historical {
			var binding PhoneResourceBinding
			if historical {
				resolver, ok := d.resources.(interface {
					ResolveRetiredRun(context.Context, agent.PhoneCommandPayload) (PhoneResourceBinding, error)
				})
				if !ok {
					return result, errors.New("phone_storage_binding_mismatch")
				}
				binding, err = resolver.ResolveRetiredRun(ctx, old)
			} else {
				binding, err = d.resources.ResolveRun(ctx, old)
			}
			historyDriver := *d
			historyDriver.policy = historyPolicy
			if err != nil || binding.NetworkID != network || historyDriver.validateBinding(old, binding) != nil || historical && binding.RetiredNodeGeneration != historicalGeneration {
				return result, errors.New("phone_storage_binding_mismatch")
			}
			instance = binding.Instance
		}
		if state.ID != item.ID || !exactPhoneContainer(state, historyPolicy.forInstance(instance), old, network) {
			return result, errors.New("phone_container_identity_mismatch")
		}
		if state.State.Running || state.State.Status != "exited" && state.State.Status != "created" {
			return result, errors.New("phone_stop_unconfirmed")
		}
		retire = append(retire, retired{old, network, instance, historyPolicy})
	}
	for _, old := range retire {
		if err := d.engine.removeStoppedPhoneContainer(ctx, old.policy.forInstance(old.instance), old.request, old.network); err != nil {
			return result, err
		}
	}
	if err := d.resources.DeleteData(ctx, p); err != nil {
		return result, err
	}
	result.RuntimeStopped = true
	result.DataDeleted = true
	return result, nil
}
