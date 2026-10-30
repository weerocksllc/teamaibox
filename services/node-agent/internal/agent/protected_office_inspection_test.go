package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

type officeInspectionRuntime struct {
	fakeRuntime
	inspected []string
	failed    bool
}

func (r *officeInspectionRuntime) InspectProtectedOfficeProfile(_ context.Context, target ExclusiveDrainTarget, ownership Ownership) (WorkerState, error) {
	r.inspected = append(r.inspected, target.WorkerID)
	if ownership.NodeID != nodeID || ownership.NodeGeneration != nodeGeneration || ownership.LeaseID != "" || ownership.FencingToken != 0 {
		return WorkerState{}, fmt.Errorf("unexpected_inspection_authority")
	}
	if r.failed {
		return WorkerState{}, fmt.Errorf("sensitive_runtime_details_must_not_escape")
	}
	return WorkerState{WorkerID: target.WorkerID, ModelProfileID: target.ModelProfileID, Image: target.RequiredImageDigest,
		ConfigDigest: target.RequiredConfigDigest, PlacementClass: target.PlacementClass, MaintenanceGeneration: target.MaintenanceGeneration,
		ContainerID: strings.Repeat("a", 64), Status: "running", Health: "unhealthy", StartedAt: fixedNow}, nil
}

func TestApplianceInspectionUsesOnlyInstalledProtectedTargetsAndRetainsUnhealthyResults(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(fmt.Sprint(failed), func(t *testing.T) {
			service, _, _ := serviceFixture(t)
			runtime := &officeInspectionRuntime{failed: failed}
			service.runtime = runtime
			service.policy.ProtectedTargetPolicyDigest = "sha256:" + strings.Repeat("b", 64)
			service.policy.ExclusiveDrainTargets["office.test"] = ExclusiveDrainTarget{TargetKey: "office.test", WorkerID: workerID,
				ModelProfileID: profileID, PlacementClass: PlacementProtectedResident, MaintenanceGeneration: 3,
				RequiredImageDigest: "registry.local/office@sha256:" + strings.Repeat("c", 64), RequiredConfigDigest: "sha256:" + strings.Repeat("d", 64)}
			commandID := "00000000-0000-4000-8000-000000000991"
			command := envelope(t, commandID, "appliance.inspect", ApplianceInspectPayload{InspectionID: commandID}, 1)
			command.LeaseID = commandID
			result, err := service.Handle(context.Background(), command, proof(t, command, "nonce-office-inspection"))
			if err != nil || result.Status != "succeeded" {
				t.Fatalf("read-only appliance inspection failed: %#v %v", result, err)
			}
			var identity ApplianceIdentity
			if err := json.Unmarshal(result.Payload, &identity); err != nil {
				t.Fatal(err)
			}
			if !identity.Healthy || identity.ProtectedTargetPolicyDigest != service.policy.ProtectedTargetPolicyDigest || len(identity.RuntimeIdentities) != 1 {
				t.Fatalf("appliance health conflated with office health: %#v", identity)
			}
			var worker ProtectedOfficeRuntimeIdentity
			if err := json.Unmarshal(identity.RuntimeIdentities[0], &worker); err != nil {
				t.Fatal(err)
			}
			if worker.WorkerID != workerID || worker.IdentityExact == failed || (!failed && worker.Health != "unhealthy") ||
				(failed && worker.ErrorCode != "protected_office_inspection_unavailable") {
				t.Fatalf("unhealthy or unavailable worker was misreported: %#v", worker)
			}
			if len(runtime.inspected) != 1 || runtime.starts != 0 || runtime.stops != 0 || runtime.health != 0 || len(runtime.drained) != 0 {
				t.Fatalf("inspection mutated worker state: %#v", runtime)
			}
			// Runtime-selected target names and foreign/current generation changes
			// must fail before invoking the fixed-policy inspection boundary.
			service.SetClock(func() time.Time { return fixedNow })
			command = envelope(t, "00000000-0000-4000-8000-000000000992", "appliance.inspect", map[string]any{
				"inspectionId": "00000000-0000-4000-8000-000000000992", "containerName": "foreign"}, 1)
			command.LeaseID = command.CommandID
			result, err = service.Handle(context.Background(), command, proof(t, command, "nonce-office-target"))
			if err != nil || result.Status != "failed" || result.ErrorCode != "invalid_appliance_inspection" || len(runtime.inspected) != 1 {
				t.Fatalf("caller target reached inspection: %#v %v", result, err)
			}
		})
	}
}
