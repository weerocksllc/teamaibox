package agent

import (
	"context"
	"errors"
	"io"
)

type ComputerInstallationRuntime interface {
	ExecuteComputerInstallation(context.Context, ComputerCommand, Ownership, io.Reader) (ComputerResult, error)
}
type ComputerInstallationDriver interface {
	ApplyComputerInstallation(context.Context, ComputerCommand, io.Reader) (ComputerResult, error)
}

// Signed metadata authorizes starting a transfer. Its size is the actual owned
// immutable object size, not an arbitrary ISO cap or a fixed-duration upload.
func (s *Service) ExecuteComputerInstallation(ctx context.Context, e CommandEnvelope, proof AuthProof, input io.Reader) (ComputerResult, error) {
	var empty ComputerResult
	if err := s.authenticator.Verify(e, proof, s.now().UTC()); err != nil {
		return empty, err
	}
	if e.NodeGeneration != s.nodeGeneration {
		return empty, ErrStaleNodeGeneration
	}
	p, err := decodeComputerCommand(e.Payload, "installation")
	if err != nil || e.Type != "virtual-computer.installation" || e.Idempotency != "keyed" || !uuidPattern.MatchString(e.CommandID) ||
		p.NodeID != s.nodeID || e.LeaseID != p.ComputerID || e.FencingToken != p.Generation+1 {
		return empty, errors.New("computer_payload_invalid")
	}
	runtime, ok := s.computers.(ComputerInstallationRuntime)
	if !ok {
		return empty, errors.New("computer_installation_unavailable")
	}
	if !s.maintenanceGate.TryRLock() {
		return empty, errors.New("computer_operation_pending")
	}
	defer s.maintenanceGate.RUnlock()
	if s.protectedMaintenance != nil && s.protectedMaintenance.BlocksOrdinaryMutation() ||
		s.protectedTransition != nil && s.protectedTransition.BlocksOrdinaryMutation() || s.applianceRestart != nil && s.applianceRestart.BlocksOrdinaryMutation() {
		return empty, errors.New("computer_operation_pending")
	}
	result, err := runtime.ExecuteComputerInstallation(ctx, p, Ownership{NodeID: s.nodeID, NodeGeneration: s.nodeGeneration, LeaseID: p.ComputerID, FencingToken: p.Generation + 1}, input)
	if err == nil {
		err = validateComputerResult("installation", p, result)
	}
	return result, err
}

func (c *ComputerCoordinator) ExecuteComputerInstallation(ctx context.Context, p ComputerCommand, authority Ownership, input io.Reader) (ComputerResult, error) {
	c.installationLifetime.RLock()
	defer c.installationLifetime.RUnlock()
	c.mu.Lock()
	defer c.mu.Unlock()
	var empty ComputerResult
	if c.root == nil || !validComputerCommand("installation", p) || p.NodeID != c.policy.NodeID || p.PoolID != c.policy.PoolID ||
		authority.NodeID != c.policy.NodeID || authority.NodeGeneration != c.policy.NodeGeneration || authority.LeaseID != p.ComputerID || authority.FencingToken != p.Generation+1 {
		return empty, errors.New("computer_policy_denied")
	}
	if err := ctx.Err(); err != nil {
		return empty, err
	}
	j, err := c.read(false)
	if err != nil {
		return empty, err
	}
	r, ok := j.Computers[p.ComputerID]
	if !ok || !sameComputerStorage(r.Command, p) || p.Generation != r.Command.Generation || p.RuntimeImage != r.Command.RuntimeImage ||
		p.Run == nil && r.Phase != "stopped" || p.Run != nil && (r.Phase != "running" || !sameComputerRun(r.Command.Run, p.Run) || computerRecordedContainer(r) != *p.Run.ContainerID) {
		return empty, errors.New("computer_state_conflict")
	}
	driver, ok := c.driver.(ComputerInstallationDriver)
	if !ok {
		return empty, errors.New("computer_installation_unavailable")
	}
	if c.installationPending[p.ComputerID] {
		return empty, errors.New("computer_operation_pending")
	}
	if c.installationPending == nil {
		c.installationPending = make(map[string]bool)
	}
	c.installationPending[p.ComputerID] = true
	defer delete(c.installationPending, p.ComputerID)
	// Preserve the lifecycle journal. Media idempotence is separately fenced by
	// installation revision; it must never turn a completed start into a new run.
	// A multi-gigabyte transfer must not block other guests or read-only status.
	c.mu.Unlock()
	result, err := driver.ApplyComputerInstallation(ctx, p, input)
	c.mu.Lock()
	if err == nil {
		err = validateComputerResult("installation", p, result)
	}
	return result, err
}
