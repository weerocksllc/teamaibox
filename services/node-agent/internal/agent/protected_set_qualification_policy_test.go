package agent

import (
	"encoding/json"
	"strings"
	"testing"
)

func qualificationPolicyFixture(t *testing.T) (Policy, []byte, string) {
	t.Helper()
	policy, _ := protectedPolicy()
	policy.ProtectedTargetPolicyDigest = "sha256:" + strings.Repeat("a", 64)
	targets := policy.ProtectedTargetsDependencyOrder()
	value := ProtectedSetQualificationPolicy{
		SchemaVersion: 1, NodeID: nodeID, NodeGeneration: nodeGeneration,
		QualificationID: "protected-office-set-v5", SetID: "office.baseline",
		ProtectedTargetPolicyDigest: policy.ProtectedTargetPolicyDigest,
		FaultInjection: ProtectedSetTransitionFaultInjection{
			StageOrder:     targets[len(targets)-1].StageOrder,
			TargetKey:      targets[len(targets)-1].TargetKey,
			InjectionPoint: legacyProtectedSetFaultInjectionPoint,
			FailureCode:    legacyProtectedSetFaultFailureCode, OneShot: true,
		},
	}
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return policy, raw, fileDigest(raw)
}

func TestProtectedSetQualificationPolicyBindsExactTargetPolicyAndFault(t *testing.T) {
	policy, raw, digest := qualificationPolicyFixture(t)
	loaded, err := decodeProtectedSetQualificationPolicy(raw, digest, policy)
	if err != nil || loaded.SourceDigest != digest || loaded.ProtectedTargetPolicyDigest != policy.ProtectedTargetPolicyDigest {
		t.Fatalf("qualification authority did not load exactly: %#v %v", loaded, err)
	}
}

func TestProtectedSetQualificationPolicyRejectsDigestTargetAndFaultDrift(t *testing.T) {
	policy, raw, digest := qualificationPolicyFixture(t)
	if _, err := decodeProtectedSetQualificationPolicy(raw, "sha256:"+strings.Repeat("f", 64), policy); err == nil {
		t.Fatal("qualification policy accepted the wrong file digest")
	}
	wrongTargetPolicy := policy
	wrongTargetPolicy.ProtectedTargetPolicyDigest = "sha256:" + strings.Repeat("e", 64)
	if _, err := decodeProtectedSetQualificationPolicy(raw, digest, wrongTargetPolicy); err == nil {
		t.Fatal("qualification policy accepted a different protected target policy")
	}
	var value ProtectedSetQualificationPolicy
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	value.FaultInjection.TargetKey = "resident.not-authorized"
	drifted, _ := json.Marshal(value)
	if _, err := decodeProtectedSetQualificationPolicy(drifted, fileDigest(drifted), policy); err == nil {
		t.Fatal("qualification policy accepted a non-policy fault target")
	}
}
