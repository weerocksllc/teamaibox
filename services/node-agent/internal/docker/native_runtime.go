package docker

import (
	"fmt"
	"teamaibox.local/node-agent/internal/agent"
)

// Bun extracts its native PTY library before dlopen. Keep general /tmp and
// secret mounts noexec; only this per-container, non-root runtime area permits
// executable mappings. It is ephemeral and never a host bind mount.
func nativeRuntimeTmpfs(security agent.SecurityProfile) string {
	return fmt.Sprintf("rw,exec,nosuid,nodev,size=67108864,uid=%d,gid=%d,mode=0700", security.RunAsUID, security.RunAsGID)
}
