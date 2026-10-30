package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const protectedSetQualificationMaximumBytes = 64 << 10

func validProtectedSetFaultInjection(value ProtectedSetTransitionFaultInjection) bool {
	return value.StageOrder >= 1 && value.StageOrder <= 32 &&
		modelAliasPattern.MatchString(value.TargetKey) &&
		value.InjectionPoint == legacyProtectedSetFaultInjectionPoint &&
		value.FailureCode == legacyProtectedSetFaultFailureCode && value.OneShot
}

func validateProtectedSetQualificationPolicy(value ProtectedSetQualificationPolicy, protected Policy) error {
	if value.SchemaVersion != 1 || !uuidPattern.MatchString(value.NodeID) || value.NodeGeneration < 1 ||
		!modelAliasPattern.MatchString(value.QualificationID) || value.SetID != "office.baseline" ||
		!policyIDPattern.MatchString(value.ProtectedTargetPolicyDigest) ||
		value.ProtectedTargetPolicyDigest != protected.ProtectedTargetPolicyDigest ||
		!validProtectedSetFaultInjection(value.FaultInjection) {
		return fmt.Errorf("protected_set_qualification_policy_invalid")
	}
	configured := protected.ProtectedTargetsDependencyOrder()
	if len(configured) == 0 || value.FaultInjection.StageOrder > len(configured) {
		return fmt.Errorf("protected_set_qualification_policy_set_drift")
	}
	target := configured[value.FaultInjection.StageOrder-1]
	if target.StageOrder != value.FaultInjection.StageOrder || target.TargetKey != value.FaultInjection.TargetKey {
		return fmt.Errorf("protected_set_qualification_policy_fault_drift")
	}
	return nil
}

func decodeProtectedSetQualificationPolicy(raw []byte, expectedDigest string, protected Policy) (*ProtectedSetQualificationPolicy, error) {
	if len(raw) < 2 || len(raw) > protectedSetQualificationMaximumBytes || fileDigest(raw) != expectedDigest {
		return nil, fmt.Errorf("protected_set_qualification_policy_digest_mismatch")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var value ProtectedSetQualificationPolicy
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("protected_set_qualification_policy_invalid")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("protected_set_qualification_policy_invalid")
	}
	value.SourceDigest = expectedDigest
	if err := validateProtectedSetQualificationPolicy(value, protected); err != nil {
		return nil, err
	}
	encoded, _ := json.Marshal(value)
	var frozen ProtectedSetQualificationPolicy
	_ = json.Unmarshal(encoded, &frozen)
	frozen.SourceDigest = expectedDigest
	return &frozen, nil
}

// LoadProtectedSetQualificationPolicy loads a digest-pinned root authority.
// It grants only the exact canonical-set fault described by the file.
func LoadProtectedSetQualificationPolicy(filename, expectedDigest string, protected Policy) (*ProtectedSetQualificationPolicy, error) {
	raw, err := ReadNodeAgentAuthorityArtifact(filename, expectedDigest, protectedSetQualificationMaximumBytes)
	if err != nil {
		return nil, fmt.Errorf("protected_set_qualification_policy_file_invalid: %w", err)
	}
	return decodeProtectedSetQualificationPolicy(raw, expectedDigest, protected)
}
