package docker

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

// InspectAppliance is read-only. All identities are taken from this installed
// Agent and host, never guessed from running model containers or mutable tags.
func (r *EngineRuntime) InspectAppliance(ctx context.Context, ownership agent.Ownership) (agent.ApplianceIdentity, error) {
	if !managedWorkerID.MatchString(ownership.NodeID) || ownership.NodeGeneration < 1 ||
		!digestID.MatchString(r.applianceImageDigest) || !digestID.MatchString(r.applianceConfigDigest) {
		return agent.ApplianceIdentity{}, fmt.Errorf("appliance_identity_not_configured")
	}
	root := strings.TrimSpace(os.Getenv("TEAMAIBOX_HOST_PROC_ROOT"))
	if root == "" {
		root = "/host/proc"
	}
	boot, err := os.ReadFile(filepath.Join(root, "sys/kernel/random/boot_id"))
	if err != nil || !managedWorkerID.MatchString(strings.TrimSpace(string(boot))) {
		return agent.ApplianceIdentity{}, fmt.Errorf("appliance_boot_identity_unavailable")
	}
	encoded, err := os.ReadFile(os.Getenv("TEAMAIBOX_TLS_CERT_FILE"))
	if err != nil {
		return agent.ApplianceIdentity{}, fmt.Errorf("appliance_certificate_unavailable")
	}
	block, _ := pem.Decode(encoded)
	if block == nil || block.Type != "CERTIFICATE" {
		return agent.ApplianceIdentity{}, fmt.Errorf("appliance_certificate_invalid")
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil || time.Now().Before(certificate.NotBefore) || !time.Now().Before(certificate.NotAfter) {
		return agent.ApplianceIdentity{}, fmt.Errorf("appliance_certificate_invalid")
	}
	if err := r.Ready(ctx); err != nil {
		return agent.ApplianceIdentity{}, err
	}
	fingerprint := sha256.Sum256(certificate.Raw)
	return agent.ApplianceIdentity{NodeID: ownership.NodeID, NodeGeneration: ownership.NodeGeneration,
		ImageDigest: r.applianceImageDigest, ConfigurationDigest: r.applianceConfigDigest,
		BootID: strings.TrimSpace(string(boot)), CertificateFingerprint: "sha256:" + hex.EncodeToString(fingerprint[:]),
		Healthy: true, RuntimeIdentities: []json.RawMessage{}}, nil
}

func syncDirectory(directory string) error {
	file, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}
