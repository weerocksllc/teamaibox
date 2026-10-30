package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sync"
)

// The installed driver owns Docker/QMP and encrypted storage. Reconcile must
// look up exact resources before effects. It may resume an incomplete create,
// but never revive an exited run. Recheck is read-only, including storage and
// clean-shutdown proof, and uses the request's operation identity in its reply.
type ComputerDriver interface {
	ComputerProtectionConfigured() bool
	ReconcileComputer(context.Context, string, ComputerCommand) (ComputerResult, error)
	RecheckComputer(context.Context, string, ComputerCommand) (ComputerResult, error)
}
type ComputerRuntimePolicy struct {
	NodeID            string
	NodeGeneration    int64
	PoolID            string
	InstalledProfiles map[string]string // profile ID -> exact installed runtime image
}
type computerRecord struct {
	Action  string          `json:"action"`
	Command ComputerCommand `json:"command"`
	Phase   string          `json:"phase"`
	Result  *ComputerResult `json:"result,omitempty"`
}
type computerJournal struct {
	Version        int                       `json:"version"`
	NodeID         string                    `json:"nodeId"`
	NodeGeneration int64                     `json:"nodeGeneration"`
	Computers      map[string]computerRecord `json:"computers"`
}

// This local identity record is part of Node Agent, not a second scheduler.
// Platform PostgreSQL owns requests and resource accounting. The record is
// synced before a side effect so replacing/reconnecting Agent cannot allocate
// another Windows disk or run for the same request.
type ComputerCoordinator struct {
	mu                   sync.Mutex
	installationLifetime sync.RWMutex
	installationPending  map[string]bool
	root                 *os.Root
	lock                 *os.File
	policy               ComputerRuntimePolicy
	driver               ComputerDriver
}

var _ ComputerCommandRuntime = (*ComputerCoordinator)(nil)

func NewComputerCoordinator(directory string, policy ComputerRuntimePolicy, driver ComputerDriver) (*ComputerCoordinator, error) {
	if !filepath.IsAbs(directory) || filepath.Clean(directory) == "/" || !uuidPattern.MatchString(policy.NodeID) || policy.NodeGeneration < 1 ||
		!phonePoolID.MatchString(policy.PoolID) || len(policy.InstalledProfiles) == 0 || driver == nil || !driver.ComputerProtectionConfigured() {
		return nil, errors.New("computer_configuration_invalid")
	}
	installed := map[string]string{}
	for id, image := range policy.InstalledProfiles {
		if !computerProfileID.MatchString(id) || !phoneImageID.MatchString(image) {
			return nil, errors.New("computer_configuration_invalid")
		}
		installed[id] = image
	}
	policy.InstalledProfiles = installed
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("computer_journal_unavailable")
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, err
	}
	c := &ComputerCoordinator{root: root, policy: policy, driver: driver}
	if info, err := root.Lstat("computers.lock"); err == nil {
		if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
			c.Close()
			return nil, errors.New("computer_journal_unavailable")
		}
	} else if !os.IsNotExist(err) {
		c.Close()
		return nil, err
	}
	c.lock, err = root.OpenFile("computers.lock", os.O_CREATE|os.O_RDWR, 0600)
	if err == nil {
		err = lockPhoneJournal(c.lock)
	} // Same process-lock primitive as Android.
	if err == nil {
		var j computerJournal
		j, err = c.read(true)
		if err == nil {
			j.NodeGeneration = policy.NodeGeneration
			err = c.write(j)
		}
	}
	if err != nil {
		c.Close()
		return nil, errors.New("computer_journal_unavailable")
	}
	return c, nil
}
func (c *ComputerCoordinator) ComputerProtectionConfigured() bool {
	return c.driver != nil && c.driver.ComputerProtectionConfigured()
}
func (c *ComputerCoordinator) Close() error {
	c.installationLifetime.Lock()
	defer c.installationLifetime.Unlock()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lock != nil {
		_ = c.lock.Close()
		c.lock = nil
	}
	if c.root != nil {
		err := c.root.Close()
		c.root = nil
		return err
	}
	return nil
}
func (c *ComputerCoordinator) read(allowOlder bool) (computerJournal, error) {
	j := computerJournal{Version: 1, NodeID: c.policy.NodeID, NodeGeneration: c.policy.NodeGeneration, Computers: map[string]computerRecord{}}
	info, err := c.root.Lstat("computers.json")
	if os.IsNotExist(err) {
		return j, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return j, errors.New("computer_journal_invalid")
	}
	f, err := c.root.Open("computers.json")
	if err != nil {
		return j, err
	}
	defer f.Close()
	d := json.NewDecoder(f)
	d.DisallowUnknownFields()
	if d.Decode(&j) != nil || !errors.Is(d.Decode(&struct{}{}), io.EOF) || j.Version != 1 || j.NodeID != c.policy.NodeID || j.NodeGeneration < 1 ||
		j.NodeGeneration > c.policy.NodeGeneration || !allowOlder && j.NodeGeneration != c.policy.NodeGeneration || j.Computers == nil {
		return j, errors.New("computer_journal_invalid")
	}
	identities := map[string]bool{}
	for id, r := range j.Computers {
		p := r.Command
		if id != p.ComputerID || p.NodeID != c.policy.NodeID || p.PoolID != c.policy.PoolID || !validComputerCommand(r.Action, p) || r.Action == "inspect" {
			return j, errors.New("computer_journal_invalid")
		}
		// Terminal history does not require a retired image to remain installed.
		for _, key := range []string{p.VolumeID, p.FirmwareID} {
			if identities[key] {
				return j, errors.New("computer_identity_mismatch")
			}
			identities[key] = true
		}
		if p.TPMID != nil {
			if identities[*p.TPMID] {
				return j, errors.New("computer_identity_mismatch")
			}
			identities[*p.TPMID] = true
		}
		if p.Run != nil {
			if identities[p.Run.ID] {
				return j, errors.New("computer_identity_mismatch")
			}
			identities[p.Run.ID] = true
		}
		switch r.Phase {
		case "creating", "stopped", "starting", "running", "stopping", "deleting", "deleted", "error":
		default:
			return j, errors.New("computer_journal_invalid")
		}
		if r.Result != nil && validateComputerResult(r.Action, p, *r.Result) != nil {
			return j, errors.New("computer_journal_invalid")
		}
	}
	return j, nil
}
func (c *ComputerCoordinator) write(j computerJournal) error {
	raw, err := json.Marshal(j)
	if err != nil {
		return err
	}
	name := ".computers-" + newUUID()
	f, err := c.root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close(); _ = c.root.Remove(name) }()
	if _, err = f.Write(raw); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = c.root.Rename(name, "computers.json"); err != nil {
		return err
	}
	dir, err := c.root.Open(".")
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
func sameComputerStorage(a, b ComputerCommand) bool {
	return a.ComputerID == b.ComputerID && a.OwnerID == b.OwnerID && a.NodeID == b.NodeID && a.PoolID == b.PoolID &&
		a.VolumeID == b.VolumeID && a.FirmwareID == b.FirmwareID && sameOptionalString(a.TPMID, b.TPMID) && a.ProfileID == b.ProfileID &&
		a.Resources == b.Resources
}
func sameComputerRun(a, b *ComputerRun) bool {
	return a != nil && b != nil && a.ID == b.ID && a.Generation == b.Generation && a.RuntimeImage == b.RuntimeImage
}
func (c *ComputerCoordinator) ExecuteComputer(ctx context.Context, action string, p ComputerCommand, authority Ownership) (ComputerResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	empty := ComputerResult{}
	if c.root == nil || !validComputerCommand(action, p) || p.NodeID != c.policy.NodeID || p.PoolID != c.policy.PoolID ||
		c.policy.InstalledProfiles[p.ProfileID] == "" || authority.NodeID != c.policy.NodeID || authority.NodeGeneration != c.policy.NodeGeneration ||
		authority.LeaseID != p.ComputerID || authority.FencingToken != p.Generation+1 {
		return empty, errors.New("computer_policy_denied")
	}
	if err := ctx.Err(); err != nil {
		return empty, err
	}
	if action != "inspect" && c.installationPending[p.ComputerID] {
		return empty, errors.New("computer_operation_pending")
	}
	j, err := c.read(false)
	if err != nil {
		return empty, err
	}
	r, exists := j.Computers[p.ComputerID]
	// New launches use the installed image. Existing operations may still use
	// their recorded old image after a maintenance update, but never an image
	// supplied independently of the durable journal.
	if c.policy.InstalledProfiles[p.ProfileID] != p.RuntimeImage &&
		(!exists || r.Command.RuntimeImage != p.RuntimeImage || action == "create" || action == "start" && r.Command.OperationID != p.OperationID) {
		return empty, errors.New("computer_policy_denied")
	}
	if exists && (!sameComputerStorage(r.Command, p) || p.Generation < r.Command.Generation) {
		return empty, errors.New("computer_identity_mismatch")
	}
	// Runtime updates are installed by maintenance policy. Only a fresh start
	// of an already stopped guest may adopt that installed image; active runs,
	// replays, shutdown and deletion remain pinned to their original runtime.
	if exists && r.Command.RuntimeImage != p.RuntimeImage &&
		(action != "start" || r.Phase != "stopped" || p.Generation <= r.Command.Generation) {
		return empty, errors.New("computer_identity_mismatch")
	}
	for id, other := range j.Computers {
		if id == p.ComputerID {
			continue
		}
		for _, candidate := range []string{p.VolumeID, p.FirmwareID, optionalComputerID(p.TPMID), computerRunID(p.Run)} {
			if candidate != "" && (candidate == other.Command.VolumeID || candidate == other.Command.FirmwareID || candidate == optionalComputerID(other.Command.TPMID) || candidate == computerRunID(other.Command.Run)) {
				return empty, errors.New("computer_identity_mismatch")
			}
		}
	}
	if action == "inspect" {
		if !exists || p.Generation != r.Command.Generation || !sameComputerRun(p.Run, r.Command.Run) {
			return empty, errors.New("computer_stale_run")
		}
		result, err := c.driver.RecheckComputer(ctx, action, p)
		if err == nil {
			err = validateComputerResult(action, p, result)
		}
		if err == nil && result.Stopped && r.Phase != "stopped" {
			// A guest may exit without a Web shutdown request. Persist that
			// exact run's terminal state before permitting a newer generation.
			// Keep the original command/result as history, never fabricate a
			// successful graceful shutdown for a crash.
			r.Phase = "stopped"
			j.Computers[p.ComputerID] = r
			err = c.write(j)
		}
		return result, err
	}
	replay := exists && r.Command.OperationID == p.OperationID
	if replay {
		if r.Action != action || !reflect.DeepEqual(r.Command, p) {
			return empty, errors.New("computer_operation_conflict")
		}
		if action == "start" && r.Phase == "stopped" && (r.Result == nil || !r.Result.Rejected) {
			return empty, errors.New("computer_run_finished")
		}
		if r.Result != nil {
			if r.Result.Rejected {
				return *r.Result, nil
			}
			// Completed starts are rechecked, never restarted from a cached
			// "running" result. An exited guest must be reconciled explicitly.
			result, err := c.driver.RecheckComputer(ctx, action, p)
			if err == nil {
				err = validateComputerResult(action, p, result)
			}
			return result, err
		}
	} else {
		switch action {
		case "create":
			if exists {
				return empty, errors.New("computer_state_conflict")
			}
		case "start":
			if !exists || r.Phase != "stopped" || p.Generation <= r.Command.Generation || computerRunID(p.Run) == computerRunID(r.Command.Run) {
				return empty, errors.New("computer_state_conflict")
			}
		case "shutdown":
			if !exists || r.Phase != "running" || p.Generation != r.Command.Generation || !sameComputerRun(p.Run, r.Command.Run) || p.Run.ContainerID == nil || *p.Run.ContainerID != computerRecordedContainer(r) {
				return empty, errors.New("computer_state_conflict")
			}
		case "delete":
			if !exists || (r.Phase != "stopped" && r.Phase != "error") || p.Generation < r.Command.Generation {
				return empty, errors.New("computer_stop_unconfirmed")
			}
		default:
			return empty, errors.New("computer_payload_invalid")
		}
		r = computerRecord{Action: action, Command: p, Phase: map[string]string{"create": "creating", "start": "starting", "shutdown": "stopping", "delete": "deleting"}[action]}
		j.Computers[p.ComputerID] = r
		if err = c.write(j); err != nil {
			return empty, err
		}
	}
	result, err := c.driver.ReconcileComputer(ctx, action, p)
	if err == nil {
		err = validateComputerResult(action, p, result)
	}
	if err != nil {
		return empty, err
	}
	if result.Rejected {
		r.Phase = map[string]string{"create": "error", "start": "stopped", "shutdown": "running", "delete": "stopped"}[action]
	} else {
		r.Phase = map[string]string{"create": "stopped", "start": "running", "shutdown": "stopped", "delete": "deleted"}[action]
	}
	r.Result = &result
	j.Computers[p.ComputerID] = r
	if err = c.write(j); err != nil {
		return empty, err
	}
	return result, nil
}
func optionalComputerID(id *string) string {
	if id == nil {
		return ""
	}
	return *id
}
func computerRunID(run *ComputerRun) string {
	if run == nil {
		return ""
	}
	return run.ID
}

func computerRecordedContainer(r computerRecord) string {
	if r.Result != nil && !r.Result.Rejected && r.Result.ContainerID != "" {
		return r.Result.ContainerID
	}
	if r.Command.Run != nil {
		return optionalComputerID(r.Command.Run.ContainerID)
	}
	return ""
}
