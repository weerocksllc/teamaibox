package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

// ComputeApplianceConfigurationDigest returns the same normalized runtime
// digest used by appliance restart verification for one raw Docker inspect
// document.  Provisioning tooling uses this narrow helper so it does not need
// to reimplement Docker's inspect normalization or expose environment values.
func ComputeApplianceConfigurationDigest(raw []byte) (string, error) {
	var document inspectDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		return "", fmt.Errorf("appliance_restart_inspect_invalid")
	}
	if strings.TrimSpace(document.ID) == "" || strings.TrimSpace(document.Config.Image) == "" {
		return "", fmt.Errorf("appliance_restart_inspect_incomplete")
	}
	return applianceConfigurationDigest(document), nil
}

func applianceIdentity(document inspectDocument) (agent.ApplianceContainerIdentity, error) {
	startedAt, err := time.Parse(time.RFC3339Nano, document.State.StartedAt)
	if err != nil || startedAt.IsZero() {
		return agent.ApplianceContainerIdentity{}, fmt.Errorf("appliance_restart_started_at_invalid")
	}
	health := "not_configured"
	if document.State.Health != nil {
		health = document.State.Health.Status
	}
	return agent.ApplianceContainerIdentity{ContainerID: document.ID, ImageID: document.Image,
		ImageReference: document.Config.Image, ConfigurationDigest: applianceConfigurationDigest(document),
		StartedAt: startedAt.UTC(), Status: document.State.Status, Health: health}, nil
}

func applianceConfigurationDigest(document inspectDocument) string {
	// The policy locators, appliance configuration identity and the public
	// configuration-digest label necessarily contain values derived from this
	// result. Redacting those self-references breaks the otherwise circular
	// digest dependency while their consumers still verify the exact runtime or
	// policy identity. Every other inspected runtime fact is covered by
	// legacyRuntimeDigest. The appliance image identity is deliberately not
	// redacted: it is not circular and must remain part of the configuration.
	clone := document
	clone.Config.Env = append([]string(nil), document.Config.Env...)
	clone.Config.Labels = make(map[string]string, len(document.Config.Labels))
	for name, value := range document.Config.Labels {
		clone.Config.Labels[name] = value
	}
	if _, found := clone.Config.Labels["com.teamaibox.config-digest"]; found {
		clone.Config.Labels["com.teamaibox.config-digest"] = "<runtime-bound>"
	}
	for index, value := range clone.Config.Env {
		name, _, found := strings.Cut(value, "=")
		if found && (name == "TEAMAIBOX_APPLIANCE_RESTART_POLICY_FILE" ||
			name == "TEAMAIBOX_APPLIANCE_RESTART_POLICY_DIGEST" ||
			name == "PLATFORM_PROTECTED_OFFICE_SET_RESTART_POLICY_DIGEST" ||
			name == "TEAMAIBOX_APPLIANCE_CONFIGURATION_DIGEST") {
			clone.Config.Env[index] = name + "=<policy-bound>"
		}
	}
	return legacyRuntimeDigest(clone)
}

func exactApplianceRestartDocument(document inspectDocument, target agent.ApplianceRestartTarget) bool {
	identity, err := applianceIdentity(document)
	return err == nil && strings.TrimPrefix(document.Name, "/") == target.ContainerName &&
		identity.ImageID == target.ImageID && identity.ImageReference == target.ImageReference &&
		identity.ConfigurationDigest == target.ConfigurationDigest &&
		identity.Status == "running" && (!target.RequireHealthy || identity.Health == "healthy")
}

func (r *EngineRuntime) InspectApplianceRestartTarget(ctx context.Context,
	target agent.ApplianceRestartTarget) (agent.ApplianceContainerIdentity, error) {
	var document inspectDocument
	if err := r.request(ctx, http.MethodGet, "/containers/"+url.PathEscape(target.ContainerName)+"/json", nil,
		&document, http.StatusOK); err != nil {
		return agent.ApplianceContainerIdentity{}, fmt.Errorf("appliance_restart_target_unavailable")
	}
	if !exactApplianceRestartDocument(document, target) {
		return agent.ApplianceContainerIdentity{}, fmt.Errorf("appliance_restart_target_identity_mismatch")
	}
	return applianceIdentity(document)
}

func (r *EngineRuntime) restartApplianceContainer(ctx context.Context, target agent.ApplianceRestartTarget) error {
	// Identity is revalidated immediately before every mutation. The caller can
	// therefore never turn an admitted policy target into a name-only restart.
	if _, err := r.InspectApplianceRestartTarget(ctx, target); err != nil {
		return err
	}
	restartClient := *r.client
	if restartClient.Timeout < 45*time.Second {
		restartClient.Timeout = 45 * time.Second
	}
	endpoint := "/containers/" + url.PathEscape(target.ContainerName) + "/restart?t=30"
	return r.requestWithClient(ctx, &restartClient, http.MethodPost, endpoint, nil, nil, http.StatusNoContent)
}

func (r *EngineRuntime) RestartAndVerifyApplianceTarget(ctx context.Context, target agent.ApplianceRestartTarget,
	previousStartedAt time.Time) (agent.ApplianceContainerIdentity, error) {
	if previousStartedAt.IsZero() {
		return agent.ApplianceContainerIdentity{}, fmt.Errorf("appliance_restart_previous_identity_invalid")
	}
	if err := r.restartApplianceContainer(ctx, target); err != nil {
		return agent.ApplianceContainerIdentity{}, err
	}
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		identity, err := r.InspectApplianceRestartTarget(ctx, target)
		if err == nil && identity.StartedAt.After(previousStartedAt) {
			return identity, nil
		}
		select {
		case <-ctx.Done():
			return agent.ApplianceContainerIdentity{}, fmt.Errorf("appliance_restart_target_not_ready")
		case <-ticker.C:
		}
	}
}

func (r *EngineRuntime) ScheduleApplianceSelfRestart(ctx context.Context, target agent.ApplianceRestartTarget) error {
	if _, err := r.InspectApplianceRestartTarget(ctx, target); err != nil {
		return err
	}
	// Give the command handler a bounded opportunity to flush its durable
	// restart-required response. The Engine call then terminates this process;
	// an interrupted connection is expected and is not converted into success.
	go func() {
		timer := time.NewTimer(250 * time.Millisecond)
		defer timer.Stop()
		<-timer.C
		background, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		_ = r.restartApplianceContainer(background, target)
	}()
	return nil
}
