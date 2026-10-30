package agent

import (
	"encoding/json"
	"os"
	"testing"
)

func TestSyntheticCompletedMaintenanceJournalAfterHostReboot(t *testing.T) {
	raw, err := os.ReadFile("testdata/synthetic_completed_maintenance.json")
	if err != nil {
		t.Fatal(err)
	}
	var j protectedMaintenanceJournal
	if err := json.Unmarshal(raw, &j); err != nil {
		t.Fatal(err)
	}
	if !validProtectedMaintenanceJournal(j, "10000000-0000-4000-8000-000000000001", 1) {
		t.Fatalf("journal rejected: schema=%v commandDigest=%v planDigest=%v phase=%v targets=%d window=%v next=%d", j.SchemaVersion, sha256Pattern.MatchString(j.CommandDigest), protectedMaintenancePlanDigest(j.Payload) == j.PlanDigest, j.Phase, len(j.Payload.Targets), j.Payload.ExpiresAt.Sub(j.Payload.IssuedAt), j.NextOperation)
	}
	if validProtectedMaintenanceJournal(j, "10000000-0000-4000-8000-000000000001", 2) {
		t.Fatal("completed historical authority must not become current after fencing")
	}
}
