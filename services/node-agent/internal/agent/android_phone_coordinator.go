package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

// The driver must inspect exact ownership before every side effect. Replaying
// Start resumes the same created/running container; it must never re-create an
// exited run. Prepare/Delete operate only on an admitted private encrypted pool.
type PhoneDriver interface {
	PreparePhoneData(context.Context, PhoneCommandPayload) (PhoneCommandResult, error)
	StartPhone(context.Context, PhoneCommandPayload) (PhoneCommandResult, error)
	InspectPhone(context.Context, PhoneCommandPayload) (PhoneCommandResult, error)
	StopPhone(context.Context, PhoneCommandPayload) (PhoneCommandResult, error)
	DeletePhoneData(context.Context, PhoneCommandPayload) (PhoneCommandResult, error)
}

type PhoneRuntimePolicy struct {
	NodeID                 string
	NodeGeneration         int64
	PoolID                 string
	ImageDigest            string
	AdditionalImageDigests []string
	// Installed, explicitly qualified same-base-build upgrades; history only.
	RetiredImageDigests []string
	RuntimeMaintenance  []PhoneRuntimeMaintenance
}

func PhoneImageAllowed(current string, additional []string, image string) bool {
	return image == current || slices.Contains(additional, image)
}

func ValidInstalledPhoneImages(current string, additional, retired []string) bool {
	if !phoneImageID.MatchString(current) || !ValidRetiredPhoneImages(current, retired) {
		return false
	}
	seen := map[string]bool{current: true}
	for _, image := range additional {
		if !phoneImageID.MatchString(image) || seen[image] || slices.Contains(retired, image) {
			return false
		}
		seen[image] = true
	}
	return true
}

func ValidRetiredPhoneImages(current string, retired []string) bool {
	seen := map[string]bool{}
	for _, image := range retired {
		if !phoneImageID.MatchString(image) || image == current || seen[image] {
			return false
		}
		seen[image] = true
	}
	return true
}

type phoneRecord struct {
	Identity            PhoneIdentity     `json:"identity"`
	Generation          uint64            `json:"generation"`
	Run                 *PhoneRunIdentity `json:"run,omitempty"`
	Phase               string            `json:"phase"`
	RequestDigest       string            `json:"requestDigest"`
	StartedAtUnixMs     int64             `json:"startedAtUnixMs,omitempty"`
	ProtectionReason    string            `json:"protectionReason,omitempty"`
	RecoveryInspectOnly bool              `json:"recoveryInspectOnly,omitempty"`
}

type phoneJournal struct {
	Version        int                    `json:"version"`
	NodeID         string                 `json:"nodeId"`
	NodeGeneration int64                  `json:"nodeGeneration"`
	Phones         map[string]phoneRecord `json:"phones"`
}

// A small persistent identity/fence journal, not a second scheduler. PostgreSQL
// owns allocation and quotas. This journal prevents a replay after Agent loss
// from reviving an old run, rebinding a disk, or repeating a completed deletion.
type PhoneCoordinator struct {
	mu          sync.Mutex
	mediaMu     sync.RWMutex
	root        *os.Root
	lock        *os.File
	policy      PhoneRuntimePolicy
	driver      PhoneDriver
	pressureMu  sync.Mutex
	memory      PhoneMemorySource
	startCancel context.CancelFunc
	used        bool
}

func NewPhoneCoordinator(directory string, policy PhoneRuntimePolicy, driver PhoneDriver) (*PhoneCoordinator, error) {
	if !filepath.IsAbs(directory) || filepath.Clean(directory) == "/" || !uuidPattern.MatchString(policy.NodeID) ||
		policy.NodeGeneration < 1 || !phonePoolID.MatchString(policy.PoolID) || !ValidInstalledPhoneImages(policy.ImageDigest, policy.AdditionalImageDigests, policy.RetiredImageDigests) || !ValidPhoneRuntimeMaintenance(policy.ImageDigest, policy.AdditionalImageDigests, policy.RuntimeMaintenance) || driver == nil {
		return nil, errors.New("phone_configuration_invalid")
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("phone_journal_directory_invalid")
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, errors.New("phone_journal_directory_invalid")
	}
	c := &PhoneCoordinator{root: root, policy: policy, driver: driver}
	// Lock across processes as well as goroutines; a replacement Agent must not
	// mutate the same journal while the previous process still owns the runtime.
	if lockInfo, statErr := root.Lstat("phones.lock"); statErr == nil {
		if !lockInfo.Mode().IsRegular() || lockInfo.Mode().Perm()&0o077 != 0 {
			c.Close()
			return nil, errors.New("phone_journal_unavailable")
		}
	} else if !os.IsNotExist(statErr) {
		c.Close()
		return nil, errors.New("phone_journal_unavailable")
	}
	c.lock, err = root.OpenFile("phones.lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err == nil {
		err = lockPhoneJournal(c.lock)
	}
	if err == nil {
		var journal phoneJournal
		journal, err = c.readGeneration(true)
		if err == nil && journal.NodeGeneration < policy.NodeGeneration {
			// The authenticated control identity may advance while Android stays
			// alive. Preserve every phone/run fence and reservation. Reconciliation
			// happens on a fresh authenticated command, whose driver verifies the
			// exact existing data, network and container. An uncertain old start
			// can only inspect; it cannot create or revive a guest after recovery.
			for id, record := range journal.Phones {
				if record.Phase == "starting" {
					record.RecoveryInspectOnly = true
					journal.Phones[id] = record
				}
			}
			journal.NodeGeneration = policy.NodeGeneration
			err = c.write(journal)
		}
	}
	if err != nil {
		c.Close()
		return nil, errors.New("phone_journal_unavailable")
	}
	return c, nil
}

func (c *PhoneCoordinator) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.mediaMu.Lock()
	defer c.mediaMu.Unlock()
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

func (c *PhoneCoordinator) read() (phoneJournal, error) {
	return c.readGeneration(false)
}

// Only constructor recovery, while holding the exclusive process lock, may
// read an older journal. Every command still requires the exact generation.
func (c *PhoneCoordinator) readGeneration(allowOlder bool) (phoneJournal, error) {
	j := phoneJournal{Version: 1, NodeID: c.policy.NodeID, NodeGeneration: c.policy.NodeGeneration, Phones: map[string]phoneRecord{}}
	info, err := c.root.Lstat("phones.json")
	if os.IsNotExist(err) {
		return j, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() > 4<<20 {
		return j, errors.New("phone_journal_invalid")
	}
	f, err := c.root.Open("phones.json")
	if err != nil {
		return j, errors.New("phone_journal_invalid")
	}
	defer f.Close()
	d := json.NewDecoder(io.LimitReader(f, (4<<20)+1))
	d.DisallowUnknownFields()
	if d.Decode(&j) != nil || j.Version != 1 || j.NodeID != c.policy.NodeID || j.NodeGeneration < 1 || j.NodeGeneration > c.policy.NodeGeneration || (!allowOlder && j.NodeGeneration != c.policy.NodeGeneration) || j.Phones == nil {
		return j, errors.New("phone_journal_invalid")
	}
	if err := d.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return j, errors.New("phone_journal_invalid")
	}
	volumes, runs, reservations := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for key, r := range j.Phones {
		identity := r.Identity
		if key != identity.PhoneID || !uuidPattern.MatchString(key) || !uuidPattern.MatchString(identity.OwnerID) ||
			!uuidPattern.MatchString(identity.VolumeID) || identity.PoolID != c.policy.PoolID || identity.BaseBuildID != PhoneBaseBuild ||
			r.Generation > 9007199254740990 || volumes[identity.VolumeID] || !regexpPhoneRequestDigest.MatchString(r.RequestDigest) ||
			r.StartedAtUnixMs < 0 || r.StartedAtUnixMs > 9007199254740990 || !validPhoneProtectionReason(r.ProtectionReason) {
			return j, errors.New("phone_journal_invalid")
		}
		volumes[identity.VolumeID] = true
		switch r.Phase {
		case "provisioning", "stopped", "starting", "running", "stopping", "deleting", "deleted":
		default:
			return j, errors.New("phone_journal_invalid")
		}
		if r.Run != nil {
			p := PhoneCommandPayload{PhoneIdentity: identity, OperationID: identity.PhoneID, Generation: r.Generation, Run: r.Run}
			// Preserve qualified closed history without adopting an old live run.
			// Deleting is retryable only through the driver's released-resource
			// checks. ExecutePhone still rejects every command with an old image.
			closedHistory := (r.Phase == "stopped" || r.Phase == "deleting") && slices.Contains(c.policy.RetiredImageDigests, r.Run.ImageDigest)
			if !validPhoneCommand("inspect", p) || (r.Phase != "deleted" && !closedHistory && !PhoneImageAllowed(c.policy.ImageDigest, c.policy.AdditionalImageDigests, r.Run.ImageDigest)) || runs[r.Run.ID] || reservations[r.Run.ReservationID] {
				return j, errors.New("phone_journal_invalid")
			}
			runs[r.Run.ID], reservations[r.Run.ReservationID] = true, true
		} else if (r.Generation != 0 && r.Phase != "deleting" && r.Phase != "deleted") ||
			r.Phase == "starting" || r.Phase == "running" || r.Phase == "stopping" {
			return j, errors.New("phone_journal_invalid")
		}
	}
	return j, nil
}

func (c *PhoneCoordinator) write(j phoneJournal) error {
	raw, err := json.Marshal(j)
	if err != nil || len(raw) > 4<<20 {
		return errors.New("phone_journal_write_failed")
	}
	name := ".phones-" + newUUID()
	f, err := c.root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return errors.New("phone_journal_write_failed")
	}
	defer func() { _ = f.Close(); _ = c.root.Remove(name) }()
	if _, err := f.Write(raw); err != nil {
		return errors.New("phone_journal_write_failed")
	}
	if f.Sync() != nil || f.Close() != nil || c.root.Rename(name, "phones.json") != nil {
		return errors.New("phone_journal_write_failed")
	}
	dir, err := c.root.Open(".")
	if err != nil {
		return errors.New("phone_journal_write_failed")
	}
	defer dir.Close()
	if dir.Sync() != nil {
		return errors.New("phone_journal_write_failed")
	}
	return nil
}

func samePhoneRun(a, b *PhoneRunIdentity) bool { return a != nil && b != nil && *a == *b }

func (c *PhoneCoordinator) ExecutePhone(ctx context.Context, action string, p PhoneCommandPayload, authority Ownership) (PhoneCommandResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var empty PhoneCommandResult
	if c.root == nil || !validPhoneCommand(action, p) || authority.NodeID != c.policy.NodeID || authority.NodeGeneration != c.policy.NodeGeneration ||
		authority.LeaseID != p.PhoneID || authority.FencingToken != p.Generation+1 || p.PoolID != c.policy.PoolID ||
		(p.Run != nil && !PhoneImageAllowed(c.policy.ImageDigest, c.policy.AdditionalImageDigests, p.Run.ImageDigest)) {
		return empty, errors.New("phone_policy_denied")
	}
	if err := ctx.Err(); err != nil {
		return empty, err
	}
	c.used = true
	j, err := c.read()
	if err != nil {
		return empty, err
	}
	r, exists := j.Phones[p.PhoneID]
	digest := phoneRequestDigest(action, p)
	if exists && r.Identity != p.PhoneIdentity {
		return empty, errors.New("phone_identity_mismatch")
	}
	// A new catalog/default is not authorization to flash an existing disk.
	// Retired-image history may still be cleaned, but never replaced on restart.
	if exists && r.Run != nil && p.Run != nil && r.Run.ImageDigest != p.Run.ImageDigest && !c.allowsHostRepair(action, r, p) {
		return empty, errors.New("phone_rom_version_mismatch")
	}
	if !exists && action != "provision" {
		return empty, errors.New("phone_not_found")
	}
	if exists && (p.Generation < r.Generation || r.Phase == "deleted" && action != "delete") {
		return empty, errors.New("phone_stale_run")
	}
	for otherID, other := range j.Phones {
		if otherID != p.PhoneID && (other.Identity.VolumeID == p.VolumeID || p.Run != nil && other.Run != nil &&
			(other.Run.ID == p.Run.ID || other.Run.ReservationID == p.Run.ReservationID)) {
			return empty, errors.New("phone_identity_mismatch")
		}
	}
	if action == "inspect" {
		if p.Generation != r.Generation || !samePhoneRun(p.Run, r.Run) {
			return empty, errors.New("phone_stale_run")
		}
		result, err := c.driver.InspectPhone(ctx, p)
		if err == nil {
			err = validatePhoneResult(action, p, result)
		}
		result.ProtectionReason = r.ProtectionReason
		return result, err
	}
	switch action {
	case "provision":
		if exists && (r.Generation != 0 || r.Phase != "provisioning" && r.Phase != "stopped" || r.RequestDigest != digest) {
			return empty, errors.New("phone_state_conflict")
		}
		r = phoneRecord{Identity: p.PhoneIdentity, Phase: "provisioning", RequestDigest: digest}
	case "start":
		if p.Generation == r.Generation {
			if (r.Phase != "starting" && r.Phase != "running") || !samePhoneRun(p.Run, r.Run) || r.RequestDigest != digest {
				return empty, errors.New("phone_stale_run")
			}
			if r.Phase == "running" || r.RecoveryInspectOnly {
				// A lost-response retry of an already admitted run is a read,
				// not a new allocation. Reapplying the quiet-start gate here
				// incorrectly rejects a healthy VM while another one boots.
				// Pressure protection still checks/stops actual runs separately.
				result, err := c.driver.InspectPhone(ctx, p)
				if err == nil {
					err = validatePhoneResult("start", p, result)
				}
				return result, err
			}
		} else {
			// Admission can reject a generation on the platform before a run
			// command reaches this node. Accept a newer signed generation only
			// from a confirmed stopped state; never reuse a previous run.
			if r.Phase != "stopped" || p.Generation <= r.Generation || r.Run != nil &&
				(r.Run.ID == p.Run.ID || r.Run.ReservationID == p.Run.ReservationID) {
				return empty, errors.New("phone_stale_run")
			}
			r.Generation, r.Run, r.Phase, r.RequestDigest = p.Generation, p.Run, "starting", digest
			r.RecoveryInspectOnly = false
			r.StartedAtUnixMs, r.ProtectionReason = time.Now().UnixMilli(), ""
		}
	case "stop":
		if p.Generation != r.Generation || !samePhoneRun(p.Run, r.Run) ||
			(r.Phase != "starting" && r.Phase != "running" && r.Phase != "stopping" && r.Phase != "stopped") {
			return empty, errors.New("phone_stale_run")
		}
		r.Phase, r.RequestDigest = "stopping", digest
	case "delete":
		// Likewise a rejected platform admission may advance its generation
		// without creating a VM. Exact data/container checks in the driver
		// still apply; a running or unconfirmed phase can never be deleted.
		if p.Generation < r.Generation || r.Phase != "stopped" && r.Phase != "deleting" && r.Phase != "deleted" ||
			p.Generation > r.Generation && r.Phase != "stopped" {
			return empty, errors.New("phone_stop_unconfirmed")
		}
		r.Generation, r.Phase, r.RequestDigest = p.Generation, "deleting", digest
	}
	// Commit before touching a runtime. Lost responses leave a recoverable exact
	// pending phase, never an unrecorded VM or an implicitly free reservation.
	j.Phones[p.PhoneID] = r
	if err := c.write(j); err != nil {
		return empty, err
	}
	var result PhoneCommandResult
	switch action {
	case "provision":
		result, err = c.driver.PreparePhoneData(ctx, p)
	case "start":
		// The journal above binds this run. Runtime allocation failures remain real errors.
		startCtx, cancel := context.WithCancel(ctx)
		c.pressureMu.Lock()
		c.startCancel = cancel
		c.pressureMu.Unlock()
		result, err = c.driver.StartPhone(startCtx, p)
		c.pressureMu.Lock()
		c.startCancel = nil
		c.pressureMu.Unlock()
		cancel()
	case "stop":
		result, err = c.driver.StopPhone(ctx, p)
	case "delete":
		result, err = c.driver.DeletePhoneData(ctx, p)
	}
	if err == nil {
		err = validatePhoneResult(action, p, result)
	}
	if err != nil {
		return empty, err
	}
	switch action {
	case "provision", "stop":
		r.Phase = "stopped"
	case "start":
		r.Phase = "running"
	case "delete":
		r.Phase = "deleted"
	}
	j.Phones[p.PhoneID] = r
	if err := c.write(j); err != nil {
		return empty, err
	}
	result.ProtectionReason = r.ProtectionReason
	return result, nil
}
