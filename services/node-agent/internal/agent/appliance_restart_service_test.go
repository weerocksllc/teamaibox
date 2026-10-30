package agent

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func applianceRestartService(t *testing.T, coordinator *ApplianceRestartCoordinator) (*Service, *memoryEvents) {
	t.Helper()
	authenticator, err := NewAuthenticator(nodeID, map[string][]byte{"scheduler-a": testKey})
	if err != nil {
		t.Fatal(err)
	}
	events := &memoryEvents{}
	service, err := NewService(nodeID, nodeGeneration, authenticator, DefaultPolicy(), &fakeRuntime{}, events)
	if err != nil {
		t.Fatal(err)
	}
	service.SetClock(func() time.Time { return fixedNow })
	if err := service.ConfigureApplianceRestart(coordinator); err != nil {
		t.Fatal(err)
	}
	return service, events
}

func restartEnvelope(t *testing.T, commandID string, payload ApplianceRuntimeRestartPayload) CommandEnvelope {
	t.Helper()
	command := envelope(t, commandID, "appliance.runtime.restart", payload, payload.JournalRevision)
	command.LeaseID = commandID
	command.Idempotency = payload.IdempotencyKey
	return command
}

func TestApplianceRestartCommandUsesAuthenticatedFixedPolicyAndDurableReplay(t *testing.T) {
	policy := restartPolicyFixture()
	journal := filepath.Join(t.TempDir(), "restart.json")
	runtime := &fakeApplianceRestartRuntime{journal: journal, identities: map[string]ApplianceContainerIdentity{
		policy.Platform.ContainerName:  restartIdentity("a", fixedNow.Add(-time.Hour)),
		policy.NodeAgent.ContainerName: restartIdentity("b", fixedNow.Add(-time.Hour)),
	}}
	coordinator, err := NewApplianceRestartCoordinator(nodeID, nodeGeneration, journal, policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	coordinator.now = func() time.Time { return fixedNow }
	service, events := applianceRestartService(t, coordinator)
	commandID := "00000000-0000-4000-8000-000000000993"
	payload := restartPayload(commandID, policy, 21)
	command := restartEnvelope(t, commandID, payload)
	armed, err := service.Handle(context.Background(), command, proof(t, command, "nonce-appliance-restart"))
	if err != nil || armed.Status != "restart-required" || runtime.scheduled != 1 ||
		!strings.Contains(string(armed.Payload), `"phase":"agent_restart_armed"`) {
		t.Fatalf("restart command was not durably armed: result=%#v error=%v runtime=%#v", armed, err, runtime)
	}
	if len(events.events) != 1 || events.events[0].Type != "appliance.runtime_restart_armed" {
		t.Fatalf("restart arm event was not bounded: %#v", events.events)
	}

	// Reconstruct the Agent and replay the exact signed command after Docker has
	// advanced the Node Agent StartedAt while retaining the exact identity.
	runtime.identities[policy.NodeAgent.ContainerName] = restartIdentity("b", fixedNow.Add(time.Minute))
	reloaded, err := NewApplianceRestartCoordinator(nodeID, nodeGeneration, journal, policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	reloadedService, reloadedEvents := applianceRestartService(t, reloaded)
	completed, err := reloadedService.Handle(context.Background(), command, proof(t, command, "nonce-appliance-restart"))
	if err != nil || completed.Status != "succeeded" || !strings.Contains(string(completed.Payload), `"phase":"complete"`) {
		t.Fatalf("exact post-restart replay was not completed: %#v %v", completed, err)
	}
	if len(reloadedEvents.events) != 1 || reloadedEvents.events[0].Type != "appliance.runtime_restart_completed" {
		t.Fatalf("restart completion event is missing: %#v", reloadedEvents.events)
	}
}

func TestApplianceRestartCommandRejectsUnknownFieldsAndUnconfiguredService(t *testing.T) {
	service, _, _ := serviceFixture(t)
	commandID := "00000000-0000-4000-8000-000000000994"
	policy := restartPolicyFixture()
	payload := restartPayload(commandID, policy, 31)
	command := restartEnvelope(t, commandID, payload)
	result, err := service.Handle(context.Background(), command, proof(t, command, "nonce-appliance-unconfigured"))
	if err != nil || result.Status != "failed" || result.ErrorCode != "appliance_restart_not_configured" {
		t.Fatalf("unconfigured restart did not fail closed: %#v %v", result, err)
	}

	coordinator, err := NewApplianceRestartCoordinator(nodeID, nodeGeneration, filepath.Join(t.TempDir(), "restart.json"), policy,
		&fakeApplianceRestartRuntime{identities: map[string]ApplianceContainerIdentity{}})
	if err != nil {
		t.Fatal(err)
	}
	configured, _ := applianceRestartService(t, coordinator)
	body, _ := json.Marshal(payload)
	command = restartEnvelope(t, "00000000-0000-4000-8000-000000000995", payload)
	command.CommandID = payload.RestartID
	command.LeaseID = payload.RestartID
	command.Payload = append(body[:len(body)-1], []byte(`,"containerName":"user-selected"}`)...)
	result, err = configured.Handle(context.Background(), command, proof(t, command, "nonce-appliance-unknown-field"))
	if err != nil || result.Status != "failed" || result.ErrorCode != "appliance_restart_identity_invalid" {
		t.Fatalf("request-selected target was not rejected: %#v %v", result, err)
	}
}
