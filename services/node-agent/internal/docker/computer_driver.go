package docker

import (
	"context"
	"errors"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

// Implemented by the installed encrypted pool/run binding. The driver does not
// infer LUKS from a directory name or perform storage operations through Docker.
// BindRun must persist one immutable allocation and recheck live admission
// before the first launch. ResolveRun is read-only; neither may replace a disk.
type ComputerResources interface {
	ComputerProtectionConfigured() bool
	PrepareComputerData(context.Context, agent.ComputerCommand) error
	VerifyComputerData(context.Context, agent.ComputerCommand) error
	BindComputerRun(context.Context, agent.ComputerCommand) (ComputerContainerBinding, error)
	ResolveComputerRun(context.Context, agent.ComputerCommand) (ComputerContainerBinding, error)
	ReadComputerStatus(context.Context, agent.ComputerCommand) (ComputerRuntimeStatus, error)
	RequestComputerShutdown(context.Context, agent.ComputerCommand) error
	DeleteComputerData(context.Context, agent.ComputerCommand) error
	VerifyComputerDeleted(context.Context, agent.ComputerCommand) error
}

type ComputerRuntimeStatus struct {
	ComputerID      string  `json:"computerId"`
	OwnerID         string  `json:"ownerId"`
	NodeID          string  `json:"nodeId"`
	VolumeID        string  `json:"volumeId"`
	FirmwareID      string  `json:"firmwareId"`
	TPMID           *string `json:"tpmId"`
	RunID           string  `json:"runId"`
	Generation      uint64  `json:"generation"`
	RuntimeImage    string  `json:"runtimeImage"`
	Phase           string  `json:"phase"`
	CleanShutdown   bool    `json:"cleanShutdown"`
	ErrorCode       *string `json:"errorCode"`
	UpdatedAtUnixMs int64   `json:"updatedAtUnixMs"`
}

func (s ComputerRuntimeStatus) matches(p agent.ComputerCommand) bool {
	return p.Run != nil && s.ComputerID == p.ComputerID && s.OwnerID == p.OwnerID && s.NodeID == p.NodeID && s.VolumeID == p.VolumeID &&
		s.FirmwareID == p.FirmwareID && (s.TPMID == nil && p.TPMID == nil || s.TPMID != nil && p.TPMID != nil && *s.TPMID == *p.TPMID) &&
		s.RunID == p.Run.ID && s.Generation == p.Generation && s.RuntimeImage == p.RuntimeImage
}

type ComputerDriver struct {
	engine           *EngineRuntime
	resources        ComputerResources
	poll             time.Duration
	maximumStatusAge time.Duration
	now              func() time.Time
}

var _ agent.ComputerDriver = (*ComputerDriver)(nil)

func NewComputerDriver(engine *EngineRuntime, resources ComputerResources, poll, maximumStatusAge time.Duration) (*ComputerDriver, error) {
	if engine == nil || resources == nil || !resources.ComputerProtectionConfigured() || poll <= 0 || maximumStatusAge < poll {
		return nil, errors.New("computer_driver_not_configured")
	}
	return &ComputerDriver{engine: engine, resources: resources, poll: poll, maximumStatusAge: maximumStatusAge, now: time.Now}, nil
}
func (d *ComputerDriver) ComputerProtectionConfigured() bool {
	return d != nil && d.resources != nil && d.resources.ComputerProtectionConfigured()
}
func computerResult(p agent.ComputerCommand) agent.ComputerResult {
	r := agent.ComputerResult{ComputerIdentity: p.ComputerIdentity}
	if p.Run != nil {
		r.RunID = p.Run.ID
		r.RuntimeImage = p.RuntimeImage
	}
	return r
}
func (d *ComputerDriver) inspect(ctx context.Context, p agent.ComputerCommand, b ComputerContainerBinding) (agent.ComputerResult, error) {
	result := computerResult(p)
	state, exists, err := d.engine.inspectComputerContainer(ctx, p, b)
	if err != nil {
		return result, err
	}
	if !exists {
		return result, errors.New("computer_runtime_missing")
	}
	result.ContainerID = state.ID
	// A created container may still have an in-flight start request. Only an
	// actual exited run proves that its runtime reservation can be released.
	result.Stopped = !state.State.Running && state.State.Status == "exited"
	if result.Stopped {
		if reclaimer, ok := d.resources.(interface {
			ReleaseComputerRun(context.Context, agent.ComputerCommand) error
		}); ok {
			if err := reclaimer.ReleaseComputerRun(ctx, p); err != nil {
				return result, err
			}
		}
	}
	status, err := d.resources.ReadComputerStatus(ctx, p)
	if err != nil || !status.matches(p) {
		if result.Stopped {
			return result, nil
		} // Known not running, never a clean-shutdown claim.
		return result, errors.New("computer_runtime_status_unavailable")
	}
	if result.Stopped {
		result.CleanShutdown = state.State.Status == "exited" && state.State.ExitCode == 0 && !state.State.OOMKilled && status.Phase == "stopped" && status.CleanShutdown && status.ErrorCode == nil
		return result, nil
	}
	age := d.now().UnixMilli() - status.UpdatedAtUnixMs
	if age < 0 || age > d.maximumStatusAge.Milliseconds() {
		return result, errors.New("computer_runtime_status_stale")
	}
	// A shutdown request is not a stopped guest. Keep recovery access available
	// while Windows is still alive, including an ignored ACPI request.
	shutdownPending := status.Phase == "stopping" && (status.ErrorCode == nil || *status.ErrorCode == "computer_shutdown_timeout")
	result.Running = state.State.Status == "running" && (status.Phase == "running" && status.ErrorCode == nil || shutdownPending)
	if result.Running {
		if reader, ok := d.resources.(interface {
			ReadComputerBootStatus(context.Context, agent.ComputerCommand) (string, string, error)
		}); ok {
			id, phase, e := reader.ReadComputerBootStatus(ctx, p)
			if e != nil {
				return result, errors.New("computer_runtime_status_unavailable")
			}
			result.BootRequestID = id
			result.BootState = phase
		}
	}
	return result, nil
}

func (d *ComputerDriver) RecheckComputer(ctx context.Context, action string, p agent.ComputerCommand) (agent.ComputerResult, error) {
	r := computerResult(p)
	switch action {
	case "create":
		if err := d.resources.VerifyComputerData(ctx, p); err != nil {
			return r, err
		}
		r.Provisioned = true
		r.Encryption = "luks2"
		return r, nil
	case "delete":
		if err := d.resources.VerifyComputerDeleted(ctx, p); err != nil {
			return r, err
		}
		r.DataDeleted = true
		return r, nil
	case "start", "shutdown", "inspect":
		b, err := d.resources.ResolveComputerRun(ctx, p)
		if err != nil {
			return r, err
		}
		r, err = d.inspect(ctx, p, b)
		if err != nil {
			return r, err
		}
		if action == "start" && !r.Running {
			return r, errors.New("computer_start_unconfirmed")
		}
		if action == "shutdown" && (!r.Stopped || !r.CleanShutdown) {
			return r, errors.New("computer_shutdown_unconfirmed")
		}
		if action == "inspect" && !r.Stopped && !r.Running {
			return r, errors.New("computer_runtime_unavailable")
		}
		return r, nil
	default:
		return r, errors.New("computer_action_invalid")
	}
}

func (d *ComputerDriver) ReconcileComputer(ctx context.Context, action string, p agent.ComputerCommand) (agent.ComputerResult, error) {
	r := computerResult(p)
	if err := ctx.Err(); err != nil {
		return r, err
	}
	switch action {
	case "create":
		if err := d.resources.PrepareComputerData(ctx, p); err != nil {
			return r, err
		}
		return d.RecheckComputer(ctx, action, p)
	case "delete":
		if err := d.resources.DeleteComputerData(ctx, p); err != nil {
			return r, err
		}
		return d.RecheckComputer(ctx, action, p)
	case "inspect":
		return d.RecheckComputer(ctx, action, p)
	case "start", "shutdown":
		var b ComputerContainerBinding
		var err error
		if action == "start" {
			b, err = d.resources.BindComputerRun(ctx, p)
			if err == nil {
				_, err = d.engine.startComputerContainer(ctx, p, b)
			}
		} else {
			b, err = d.resources.ResolveComputerRun(ctx, p)
			if err == nil {
				var state phoneEngineState
				var exists bool
				state, exists, err = d.engine.inspectComputerContainer(ctx, p, b)
				if err == nil && !exists {
					err = errors.New("computer_runtime_missing")
				}
				if err == nil && state.State.Running {
					err = d.resources.RequestComputerShutdown(ctx, p)
				}
			}
		}
		if err != nil {
			return r, err
		}
		ticker := time.NewTicker(d.poll)
		defer ticker.Stop()
		for {
			r, err = d.inspect(ctx, p, b)
			if err == nil {
				if action == "start" && r.Running || action == "shutdown" && r.Stopped && r.CleanShutdown {
					return r, nil
				}
				if r.Stopped {
					return r, errors.New("computer_run_stopped_without_requested_result")
				}
				if action == "shutdown" {
					// The durable queue will inspect this same request again. Do not
					// hold the coordinator mutex while waiting for the guest: doing
					// so blocks the very console needed to resolve a stuck shutdown.
					return r, errors.New("computer_shutdown_pending")
				}
			} else if err.Error() != "computer_runtime_status_unavailable" {
				return r, err
			}
			select {
			case <-ctx.Done():
				return r, ctx.Err()
			case <-ticker.C:
			}
			// No Docker stop/kill on timeout: Windows may still be writing its disk.
			// The same durable operation will reconcile the later result.
		}
	default:
		return r, errors.New("computer_action_invalid")
	}
}
