package docker

import (
	"strings"

	"teamaibox.local/node-agent/internal/agent"
)

func workerStartSpecDigest(spec agent.WorkerStartPayload) string {
	return strings.TrimPrefix(agent.WorkerStartSpecDigest(spec), "sha256:")
}
