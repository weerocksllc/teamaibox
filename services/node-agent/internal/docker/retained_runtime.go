package docker

import (
	"strconv"
	"teamaibox.local/node-agent/internal/agent"
)

// Only access to an existing resident model or stateless application may use
// its creation generation after a control reconnect. Never use this helper
// for start, stop, drain, restore, or maintenance. Callers still match the
// exact node, worker, lease and fencing token and enforce health/network rules.
func runtimeGenerationMatches(document inspectDocument, ownership agent.Ownership) bool {
	generation := ownership.NodeGeneration
	if ownership.RuntimeGeneration != 0 {
		if ownership.RuntimeGeneration < 1 || ownership.RuntimeGeneration > generation {
			return false
		}
		if ownership.RuntimeGeneration < generation {
			labels := document.Config.Labels
			placement, _, _, err := placementState(labels)
			if err != nil || !(labels["com.teamaibox.kind"] == "application-plugin" ||
				(labels["com.teamaibox.kind"] == "compute-worker" && agent.IsProtectedPlacement(placement))) {
				return false
			}
		}
		generation = ownership.RuntimeGeneration
	}
	return document.Config.Labels["com.teamaibox.node-generation"] == strconv.FormatInt(generation, 10)
}
