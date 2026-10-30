package agent

import "testing"

func TestCanonicalCompanionCreateIsBoundToLocalFullSpecification(t *testing.T) {
	policy, migration, workers := migrationPolicyFixture(t)
	spec := migration.Targets[2].DesiredCompanions[0]
	target := policy.ExclusiveDrainTargets["office.ocr-hunyuan"]
	target.DependentContainers[0].RequiredStartSpecDigest = canonicalPolicyDigest(spec)
	change := ProtectedSetTransitionTarget{DesiredWorker: workers[2], DesiredTarget: target, DesiredCompanions: []ProtectedCompanionStartPayload{spec}}
	c := &ProtectedSetTransitionCoordinator{policy: policy}
	if !c.validCanonicalCompanions(change) {
		t.Fatal("normal bound companion rejected")
	}
	for _, mutate := range []func(*ProtectedSetTransitionTarget){
		func(v *ProtectedSetTransitionTarget) { v.DesiredCompanions[0].Command = []string{"different-command"} },
		func(v *ProtectedSetTransitionTarget) { v.DesiredCompanions[0].Limits.MemoryBytes++ },
		func(v *ProtectedSetTransitionTarget) { v.DesiredCompanions[0].ParentWorkerID = workers[0].WorkerID },
		func(v *ProtectedSetTransitionTarget) { v.DesiredCompanions[0].Security.Privileged = true },
		func(v *ProtectedSetTransitionTarget) {
			v.DesiredTarget.DependentContainers[0].RequiredStartSpecDigest = ""
		},
	} {
		copy := change
		copy.DesiredCompanions = append([]ProtectedCompanionStartPayload(nil), change.DesiredCompanions...)
		copy.DesiredTarget.DependentContainers = append([]ExclusiveDependentContainer(nil), change.DesiredTarget.DependentContainers...)
		mutate(&copy)
		if c.validCanonicalCompanions(copy) {
			t.Fatal("accepted unbound companion mutation")
		}
	}
}
