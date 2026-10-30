package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

const applianceRestartPolicyMaximumBytes = 64 << 10

// A verified older policy disables only this optional operation. It must not
// prevent the node from reconnecting and reporting its current generation.
var ErrApplianceRestartAuthorityExpired = errors.New("appliance_restart_authority_refresh_required")

// LoadApplianceRestartPolicy loads a deployment-owned, immutable allowlist.
// The expected digest is injected independently so replacing the mounted file
// alone can never widen restart authority.
func LoadApplianceRestartPolicy(filename, expectedDigest, nodeID string, nodeGeneration int64) (ApplianceRestartPolicy, error) {
	if filename == "" || filename[0] != '/' || !digestIDPattern.MatchString(expectedDigest) ||
		!uuidPattern.MatchString(nodeID) || nodeGeneration < 1 {
		return ApplianceRestartPolicy{}, fmt.Errorf("appliance_restart_policy_configuration_invalid")
	}
	info, err := os.Lstat(filename)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() < 2 ||
		info.Size() > applianceRestartPolicyMaximumBytes || info.Mode().Perm()&0o022 != 0 {
		return ApplianceRestartPolicy{}, fmt.Errorf("appliance_restart_policy_invalid")
	}
	file, err := os.Open(filename)
	if err != nil {
		return ApplianceRestartPolicy{}, fmt.Errorf("appliance_restart_policy_invalid")
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, applianceRestartPolicyMaximumBytes+1))
	if err != nil || len(raw) > applianceRestartPolicyMaximumBytes {
		return ApplianceRestartPolicy{}, fmt.Errorf("appliance_restart_policy_invalid")
	}
	digest := sha256.Sum256(raw)
	actualDigest := "sha256:" + hex.EncodeToString(digest[:])
	if actualDigest != expectedDigest {
		return ApplianceRestartPolicy{}, fmt.Errorf("appliance_restart_policy_digest_mismatch")
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	var policy ApplianceRestartPolicy
	if err := decoder.Decode(&policy); err != nil {
		return ApplianceRestartPolicy{}, fmt.Errorf("appliance_restart_policy_invalid")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ApplianceRestartPolicy{}, fmt.Errorf("appliance_restart_policy_invalid")
	}
	// policyDigest binds the semantic document excluding the digest field,
	// while expectedDigest binds the exact serialized deployment artifact.
	semantic := policy
	semantic.PolicyDigest = ""
	semanticDigest := applianceRestartDigest(semantic)
	if policy.PolicyDigest != semanticDigest || !validApplianceRestartPolicy(policy, nodeID, policy.NodeGeneration) ||
		policy.NodeGeneration < 1 || policy.NodeGeneration > nodeGeneration {
		return ApplianceRestartPolicy{}, fmt.Errorf("appliance_restart_policy_invalid")
	}
	if policy.NodeGeneration < nodeGeneration {
		return policy, ErrApplianceRestartAuthorityExpired
	}
	return policy, nil
}
