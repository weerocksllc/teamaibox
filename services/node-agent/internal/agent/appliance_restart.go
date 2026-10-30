package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

const (
	applianceRestartJournalSchema    = 1
	applianceRestartMaximumBytes     = 128 << 10
	applianceRestartExecutionTimeout = 120 * time.Second
)

var applianceRestartNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
var errApplianceRestartRearmed = errors.New("appliance restart re-armed")

// ApplianceRestartTarget is loaded only from a digest-bound local policy file.
// It is never accepted from a command payload. This keeps the restart command
// incapable of becoming a generic Docker control surface.
type ApplianceRestartTarget struct {
	ContainerName       string `json:"containerName"`
	ImageID             string `json:"imageId"`
	ImageReference      string `json:"imageReference"`
	ConfigurationDigest string `json:"configurationDigest"`
	RequireHealthy      bool   `json:"requireHealthy"`
}

type ApplianceRestartPolicy struct {
	SchemaVersion  int                    `json:"schemaVersion"`
	NodeID         string                 `json:"nodeId"`
	NodeGeneration int64                  `json:"nodeGeneration"`
	PolicyDigest   string                 `json:"policyDigest"`
	Platform       ApplianceRestartTarget `json:"platform"`
	NodeAgent      ApplianceRestartTarget `json:"nodeAgent"`
}

// ApplianceRuntimeRestartPayload intentionally contains no container name,
// image reference, or Docker action. The only selectable object is the exact
// policy digest already mounted into this Node Agent deployment.
type ApplianceRuntimeRestartPayload struct {
	RestartID       string `json:"restartId"`
	JournalRevision uint64 `json:"journalRevision"`
	PolicyDigest    string `json:"policyDigest"`
	IdempotencyKey  string `json:"idempotencyKey"`
}

type ApplianceContainerIdentity struct {
	ContainerID         string    `json:"containerId"`
	ImageID             string    `json:"imageId"`
	ImageReference      string    `json:"imageReference"`
	ConfigurationDigest string    `json:"configurationDigest"`
	StartedAt           time.Time `json:"startedAt"`
	Status              string    `json:"status"`
	Health              string    `json:"health"`
}

type ApplianceRestartJournalRevisions struct {
	Prepared           uint64 `json:"prepared"`
	PlatformRestarting uint64 `json:"platformRestarting"`
	PlatformVerified   uint64 `json:"platformVerified"`
	AgentRestartArmed  uint64 `json:"agentRestartArmed"`
	Complete           uint64 `json:"complete,omitempty"`
}

type ApplianceRestartState struct {
	RestartID      string                                `json:"restartId"`
	PolicyDigest   string                                `json:"policyDigest"`
	IdempotencyKey string                                `json:"idempotencyKey"`
	Phase          string                                `json:"phase"`
	Pre            map[string]ApplianceContainerIdentity `json:"pre"`
	Post           map[string]ApplianceContainerIdentity `json:"post,omitempty"`
	Revisions      ApplianceRestartJournalRevisions      `json:"journalRevisions"`
	UpdatedAt      time.Time                             `json:"updatedAt"`
}

type applianceRestartJournal struct {
	SchemaVersion  int                                   `json:"schemaVersion"`
	NodeID         string                                `json:"nodeId"`
	NodeGeneration int64                                 `json:"nodeGeneration"`
	CommandID      string                                `json:"commandId"`
	CommandDigest  string                                `json:"commandDigest"`
	Payload        ApplianceRuntimeRestartPayload        `json:"payload"`
	Phase          string                                `json:"phase"`
	Pre            map[string]ApplianceContainerIdentity `json:"pre"`
	Post           map[string]ApplianceContainerIdentity `json:"post,omitempty"`
	Revisions      ApplianceRestartJournalRevisions      `json:"journalRevisions"`
	UpdatedAt      time.Time                             `json:"updatedAt"`
}

// ApplianceRestartRuntime is deliberately restricted to exact identities. An
// implementation never receives request-controlled container identifiers.
type ApplianceRestartRuntime interface {
	InspectApplianceRestartTarget(context.Context, ApplianceRestartTarget) (ApplianceContainerIdentity, error)
	RestartAndVerifyApplianceTarget(context.Context, ApplianceRestartTarget, time.Time) (ApplianceContainerIdentity, error)
	ScheduleApplianceSelfRestart(context.Context, ApplianceRestartTarget) error
}

type ApplianceRestartCoordinator struct {
	nodeID         string
	nodeGeneration int64
	journalFile    string
	policy         ApplianceRestartPolicy
	runtime        ApplianceRestartRuntime
	now            func() time.Time
	mu             sync.Mutex
	journal        *applianceRestartJournal
}

func applianceRestartDigest(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	digest := sha256.Sum256(encoded)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func applianceRestartTargetValid(target ApplianceRestartTarget) bool {
	return applianceRestartNamePattern.MatchString(target.ContainerName) && digestIDPattern.MatchString(target.ImageID) &&
		len(target.ImageReference) > 3 && len(target.ImageReference) <= 512 &&
		!bytes.ContainsRune([]byte(target.ImageReference), '\x00') && digestIDPattern.MatchString(target.ConfigurationDigest)
}

var digestIDPattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)

func validApplianceRestartPolicy(policy ApplianceRestartPolicy, nodeID string, nodeGeneration int64) bool {
	return policy.SchemaVersion == 1 && policy.NodeID == nodeID && policy.NodeGeneration == nodeGeneration &&
		digestIDPattern.MatchString(policy.PolicyDigest) && applianceRestartTargetValid(policy.Platform) &&
		applianceRestartTargetValid(policy.NodeAgent) && policy.Platform.RequireHealthy && policy.NodeAgent.RequireHealthy &&
		policy.Platform.ContainerName != policy.NodeAgent.ContainerName
}

func NewApplianceRestartCoordinator(nodeID string, nodeGeneration int64, journalFile string,
	policy ApplianceRestartPolicy, runtime ApplianceRestartRuntime) (*ApplianceRestartCoordinator, error) {
	if !uuidPattern.MatchString(nodeID) || nodeGeneration < 1 || !filepath.IsAbs(journalFile) ||
		filepath.Clean(journalFile) == "/" || runtime == nil || !validApplianceRestartPolicy(policy, nodeID, nodeGeneration) {
		return nil, fmt.Errorf("appliance_restart_configuration_invalid")
	}
	coordinator := &ApplianceRestartCoordinator{nodeID: nodeID, nodeGeneration: nodeGeneration,
		journalFile: journalFile, policy: policy, runtime: runtime, now: time.Now}
	journal, err := coordinator.readJournal()
	if err != nil {
		return nil, err
	}
	coordinator.journal = journal
	return coordinator, nil
}

func validApplianceRestartIdentity(identity ApplianceContainerIdentity) bool {
	return sha256Pattern.MatchString(identity.ContainerID) && digestIDPattern.MatchString(identity.ImageID) &&
		digestIDPattern.MatchString(identity.ConfigurationDigest) && identity.ImageReference != "" &&
		!identity.StartedAt.IsZero() && identity.Status == "running" &&
		(identity.Health == "healthy" || identity.Health == "not_configured")
}

func validApplianceRestartJournal(value applianceRestartJournal, nodeID string, nodeGeneration int64, policy ApplianceRestartPolicy) bool {
	if value.SchemaVersion != applianceRestartJournalSchema || value.NodeID != nodeID || value.NodeGeneration != nodeGeneration ||
		!uuidPattern.MatchString(value.CommandID) || !sha256Pattern.MatchString(value.CommandDigest) ||
		value.Payload.RestartID != value.CommandID || value.Payload.PolicyDigest != policy.PolicyDigest ||
		!digestIDPattern.MatchString(value.Payload.IdempotencyKey) || value.Payload.JournalRevision < 1 ||
		value.UpdatedAt.IsZero() || len(value.Pre) != 2 {
		return false
	}
	for _, role := range []string{"platform", "nodeAgent"} {
		if !validApplianceRestartIdentity(value.Pre[role]) {
			return false
		}
	}
	if !identityMatchesTarget(value.Pre["platform"], policy.Platform) ||
		!identityMatchesTarget(value.Pre["nodeAgent"], policy.NodeAgent) {
		return false
	}
	base := value.Payload.JournalRevision
	if value.Revisions.Prepared != base || value.Revisions.PlatformRestarting != base+1 ||
		value.Revisions.PlatformVerified != base+2 || value.Revisions.AgentRestartArmed != base+3 {
		return false
	}
	switch value.Phase {
	case "prepared":
		return len(value.Post) == 0 && value.Revisions.Complete == 0
	case "platform_restarting":
		return len(value.Post) == 0 && value.Revisions.Complete == 0
	case "platform_verified", "agent_restart_armed":
		return len(value.Post) == 1 && validApplianceRestartIdentity(value.Post["platform"]) &&
			identityMatchesTarget(value.Post["platform"], policy.Platform) &&
			identityRestarted(value.Pre["platform"], value.Post["platform"]) && value.Revisions.Complete == 0
	case "complete":
		return len(value.Post) == 2 && validApplianceRestartIdentity(value.Post["platform"]) &&
			validApplianceRestartIdentity(value.Post["nodeAgent"]) &&
			identityMatchesTarget(value.Post["platform"], policy.Platform) &&
			identityMatchesTarget(value.Post["nodeAgent"], policy.NodeAgent) &&
			identityRestarted(value.Pre["platform"], value.Post["platform"]) &&
			identityRestarted(value.Pre["nodeAgent"], value.Post["nodeAgent"]) && value.Revisions.Complete == base+4
	default:
		return false
	}
}

func (c *ApplianceRestartCoordinator) readJournal() (*applianceRestartJournal, error) {
	info, err := os.Lstat(c.journalFile)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() ||
		info.Size() < 2 || info.Size() > applianceRestartMaximumBytes || info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("appliance_restart_journal_invalid")
	}
	file, err := os.Open(c.journalFile)
	if err != nil {
		return nil, fmt.Errorf("appliance_restart_journal_invalid")
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, applianceRestartMaximumBytes+1))
	decoder.DisallowUnknownFields()
	var value applianceRestartJournal
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("appliance_restart_journal_invalid")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) ||
		!validApplianceRestartJournal(value, c.nodeID, c.nodeGeneration, c.policy) {
		return nil, fmt.Errorf("appliance_restart_journal_invalid")
	}
	return &value, nil
}

func (c *ApplianceRestartCoordinator) writeJournal(value *applianceRestartJournal) error {
	if value == nil || !validApplianceRestartJournal(*value, c.nodeID, c.nodeGeneration, c.policy) {
		return fmt.Errorf("appliance_restart_journal_invalid")
	}
	encoded, err := json.Marshal(value)
	if err != nil || len(encoded) > applianceRestartMaximumBytes {
		return fmt.Errorf("appliance_restart_journal_invalid")
	}
	directory := filepath.Dir(c.journalFile)
	if info, statErr := os.Lstat(directory); statErr != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("appliance_restart_journal_write_failed")
	}
	temporary, err := os.CreateTemp(directory, ".appliance-restart-journal-")
	if err != nil {
		return fmt.Errorf("appliance_restart_journal_write_failed")
	}
	name := temporary.Name()
	defer os.Remove(name)
	if temporary.Chmod(0o600) != nil {
		_ = temporary.Close()
		return fmt.Errorf("appliance_restart_journal_write_failed")
	}
	if _, err = temporary.Write(append(encoded, '\n')); err != nil || temporary.Sync() != nil || temporary.Close() != nil ||
		os.Rename(name, c.journalFile) != nil {
		return fmt.Errorf("appliance_restart_journal_write_failed")
	}
	directoryFile, err := os.Open(directory)
	if err != nil {
		return fmt.Errorf("appliance_restart_journal_write_failed")
	}
	defer directoryFile.Close()
	if directoryFile.Sync() != nil {
		return fmt.Errorf("appliance_restart_journal_write_failed")
	}
	c.journal = value
	return nil
}

func identityMatchesTarget(identity ApplianceContainerIdentity, target ApplianceRestartTarget) bool {
	return identity.ImageID == target.ImageID && identity.ImageReference == target.ImageReference &&
		identity.ConfigurationDigest == target.ConfigurationDigest &&
		identity.Status == "running" && (!target.RequireHealthy || identity.Health == "healthy")
}

func identityRestarted(pre, post ApplianceContainerIdentity) bool {
	return pre.ContainerID == post.ContainerID && pre.ImageID == post.ImageID && pre.ImageReference == post.ImageReference &&
		pre.ConfigurationDigest == post.ConfigurationDigest && post.StartedAt.After(pre.StartedAt)
}

func (c *ApplianceRestartCoordinator) stateLocked() ApplianceRestartState {
	if c.journal == nil {
		return ApplianceRestartState{}
	}
	pre := make(map[string]ApplianceContainerIdentity, len(c.journal.Pre))
	post := make(map[string]ApplianceContainerIdentity, len(c.journal.Post))
	for key, value := range c.journal.Pre {
		pre[key] = value
	}
	for key, value := range c.journal.Post {
		post[key] = value
	}
	return ApplianceRestartState{RestartID: c.journal.CommandID, PolicyDigest: c.journal.Payload.PolicyDigest,
		IdempotencyKey: c.journal.Payload.IdempotencyKey, Phase: c.journal.Phase, Pre: pre, Post: post,
		Revisions: c.journal.Revisions, UpdatedAt: c.journal.UpdatedAt}
}

func (c *ApplianceRestartCoordinator) setPhase(value *applianceRestartJournal, phase string, now time.Time) error {
	value.Phase = phase
	value.UpdatedAt = now.UTC()
	return c.writeJournal(value)
}

func (c *ApplianceRestartCoordinator) recoverLocked(ctx context.Context, now time.Time, allowRearm bool) error {
	if c.journal == nil || c.journal.Phase == "complete" {
		return nil
	}
	// No phase before agent_restart_armed may be guessed across a process loss.
	// Those phases require operator-visible failure and a bounded new deployment,
	// because repeating a Platform mutation without proof could hide drift.
	if c.journal.Phase != "agent_restart_armed" {
		return fmt.Errorf("appliance_restart_recovery_incomplete")
	}
	platform, err := c.runtime.InspectApplianceRestartTarget(ctx, c.policy.Platform)
	if err != nil || !identityMatchesTarget(platform, c.policy.Platform) ||
		!identityRestarted(c.journal.Pre["platform"], platform) {
		return fmt.Errorf("appliance_restart_platform_identity_invalid")
	}
	agentIdentity, err := c.runtime.InspectApplianceRestartTarget(ctx, c.policy.NodeAgent)
	if err != nil || !identityMatchesTarget(agentIdentity, c.policy.NodeAgent) {
		return fmt.Errorf("appliance_restart_agent_identity_invalid")
	}
	if !identityRestarted(c.journal.Pre["nodeAgent"], agentIdentity) {
		if !allowRearm {
			return fmt.Errorf("appliance_restart_agent_not_restarted")
		}
		// The Engine restart may have failed before terminating this process. It
		// is safe to re-arm only the exact same policy-bound self restart.
		if err := c.runtime.ScheduleApplianceSelfRestart(ctx, c.policy.NodeAgent); err != nil {
			return fmt.Errorf("appliance_restart_agent_schedule_failed")
		}
		return errApplianceRestartRearmed
	}
	// Do not release the command guard unless completion was durably saved.
	completed := *c.journal
	completed.Post = map[string]ApplianceContainerIdentity{"platform": platform, "nodeAgent": agentIdentity}
	completed.Revisions.Complete = completed.Payload.JournalRevision + 4
	return c.setPhase(&completed, "complete", now)
}

// ReconcileAfterStart verifies an already-armed restart without a controller
// replay. Call only after starting the HTTP listener: Docker's healthcheck
// needs that listener. It never restarts a container or guesses an earlier
// transaction phase, and briefly tolerates healthchecks still starting up.
func (c *ApplianceRestartCoordinator) ReconcileAfterStart(ctx context.Context) (ApplianceRestartState, error) {
	ctx, cancel := context.WithTimeout(ctx, applianceRestartExecutionTimeout)
	defer cancel()
	return c.reconcileAfterStart(ctx, time.Second)
}

func (c *ApplianceRestartCoordinator) reconcileAfterStart(ctx context.Context, interval time.Duration) (ApplianceRestartState, error) {
	for {
		if err := ctx.Err(); err != nil {
			return ApplianceRestartState{}, fmt.Errorf("appliance_restart_recovery_incomplete: %w", err)
		}
		c.mu.Lock()
		state := c.stateLocked()
		if state.Phase != "" && state.Phase != "complete" && state.Phase != "agent_restart_armed" {
			c.mu.Unlock()
			return state, fmt.Errorf("appliance_restart_recovery_incomplete")
		}
		err := c.recoverLocked(ctx, c.now().UTC(), false)
		state = c.stateLocked()
		c.mu.Unlock()
		if err == nil {
			return state, nil
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return state, fmt.Errorf("appliance_restart_recovery_incomplete: %w", err)
		case <-timer.C:
		}
	}
}

func (c *ApplianceRestartCoordinator) Execute(ctx context.Context, payload ApplianceRuntimeRestartPayload,
	commandID, commandDigestValue, envelopeIdempotency string, now time.Time) (ApplianceRestartState, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if payload.RestartID != commandID || payload.PolicyDigest != c.policy.PolicyDigest || payload.JournalRevision < 1 ||
		!digestIDPattern.MatchString(payload.IdempotencyKey) || envelopeIdempotency != payload.IdempotencyKey ||
		!sha256Pattern.MatchString(commandDigestValue) {
		return ApplianceRestartState{}, fmt.Errorf("appliance_restart_identity_invalid")
	}
	if ctx.Err() != nil {
		return ApplianceRestartState{}, fmt.Errorf("appliance_restart_request_cancelled")
	}
	if c.journal != nil {
		if c.journal.CommandID == commandID {
			if c.journal.CommandDigest != commandDigestValue || c.journal.Payload != payload {
				return ApplianceRestartState{}, fmt.Errorf("appliance_restart_idempotency_conflict")
			}
			if err := c.recoverLocked(ctx, now, true); err != nil {
				if errors.Is(err, errApplianceRestartRearmed) {
					// A successfully re-armed self restart still returns the durable
					// restart-required state to the exact replaying controller.
					return c.stateLocked(), nil
				}
				return ApplianceRestartState{}, err
			}
			return c.stateLocked(), nil
		}
		if c.journal.Phase != "complete" || payload.JournalRevision <= c.journal.Revisions.Complete {
			return ApplianceRestartState{}, fmt.Errorf("appliance_restart_in_progress")
		}
	}
	platformPre, err := c.runtime.InspectApplianceRestartTarget(ctx, c.policy.Platform)
	if err != nil || !identityMatchesTarget(platformPre, c.policy.Platform) {
		return ApplianceRestartState{}, fmt.Errorf("appliance_restart_platform_identity_invalid")
	}
	agentPre, err := c.runtime.InspectApplianceRestartTarget(ctx, c.policy.NodeAgent)
	if err != nil || !identityMatchesTarget(agentPre, c.policy.NodeAgent) {
		return ApplianceRestartState{}, fmt.Errorf("appliance_restart_agent_identity_invalid")
	}
	journal := &applianceRestartJournal{SchemaVersion: applianceRestartJournalSchema, NodeID: c.nodeID,
		NodeGeneration: c.nodeGeneration, CommandID: commandID, CommandDigest: commandDigestValue, Payload: payload,
		Phase: "prepared", Pre: map[string]ApplianceContainerIdentity{"platform": platformPre, "nodeAgent": agentPre},
		Post: map[string]ApplianceContainerIdentity{}, Revisions: ApplianceRestartJournalRevisions{
			Prepared: payload.JournalRevision, PlatformRestarting: payload.JournalRevision + 1,
			PlatformVerified: payload.JournalRevision + 2, AgentRestartArmed: payload.JournalRevision + 3}, UpdatedAt: now.UTC()}
	// This fsynced record is deliberately the first state change, before the
	// first Docker Engine mutation.
	if ctx.Err() != nil {
		return ApplianceRestartState{}, fmt.Errorf("appliance_restart_request_cancelled")
	}
	if err := c.writeJournal(journal); err != nil {
		return ApplianceRestartState{}, err
	}
	// Restarting Platform deliberately disconnects this command's HTTP caller.
	// Only after exact policy admission and fsynced intent may its execution
	// outlive that connection. Keep a fixed bound; do not detach preflight or
	// turn a cancelled unauthenticated request into a new restart operation.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), applianceRestartExecutionTimeout)
	defer cancel()
	if err := c.setPhase(journal, "platform_restarting", c.now().UTC()); err != nil {
		return ApplianceRestartState{}, err
	}
	platformPost, err := c.runtime.RestartAndVerifyApplianceTarget(ctx, c.policy.Platform, platformPre.StartedAt)
	if err != nil || !identityMatchesTarget(platformPost, c.policy.Platform) || !identityRestarted(platformPre, platformPost) {
		return ApplianceRestartState{}, fmt.Errorf("appliance_restart_platform_restart_failed")
	}
	journal.Post["platform"] = platformPost
	if err := c.setPhase(journal, "platform_verified", c.now().UTC()); err != nil {
		return ApplianceRestartState{}, err
	}
	if err := c.setPhase(journal, "agent_restart_armed", c.now().UTC()); err != nil {
		return ApplianceRestartState{}, err
	}
	if err := c.runtime.ScheduleApplianceSelfRestart(ctx, c.policy.NodeAgent); err != nil {
		return ApplianceRestartState{}, fmt.Errorf("appliance_restart_agent_schedule_failed")
	}
	return c.stateLocked(), nil
}

func (c *ApplianceRestartCoordinator) BlocksOrdinaryMutation() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.journal != nil && c.journal.Phase != "complete"
}
