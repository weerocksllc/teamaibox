package docker

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

// This is not worker.health with relaxed lease fencing. It is a separate
// read-only view selected solely by the Agent's installed protected policy.
// No lease is allocated or reconstructed, and no Docker mutation is allowed.
func (r *EngineRuntime) InspectProtectedOfficeProfile(ctx context.Context, target agent.ExclusiveDrainTarget,
	ownership agent.Ownership) (agent.WorkerState, error) {
	if target.PlacementClass != agent.PlacementProtectedResident || !managedWorkerID.MatchString(target.WorkerID) ||
		!managedWorkerID.MatchString(target.ModelProfileID) ||
		!managedWorkerID.MatchString(ownership.NodeID) || ownership.NodeGeneration < 1 {
		return agent.WorkerState{}, fmt.Errorf("protected_office_target_denied")
	}
	var document inspectDocument
	if err := r.request(ctx, http.MethodGet, "/containers/"+url.PathEscape(target.ContainerName)+"/json", nil, &document, http.StatusOK); err != nil {
		return agent.WorkerState{}, fmt.Errorf("protected_office_target_unavailable")
	}
	labels := document.Config.Labels
	// A control-service reconnect advances its generation without recreating
	// resident workers. Read-only inspection accepts that retained generation
	// only when the installed policy binds it exactly; mutation fencing is unchanged.
	workerGeneration, generationErr := strconv.ParseInt(labels["com.teamaibox.node-generation"], 10, 64)
	retainedGeneration := workerGeneration == ownership.NodeGeneration ||
		(target.RequiredLabels["com.teamaibox.node-generation"] == labels["com.teamaibox.node-generation"] &&
			workerGeneration < ownership.NodeGeneration)
	startSpec := strings.TrimPrefix(labels["com.teamaibox.start-spec-digest"], "sha256:")
	startedAt, startedErr := time.Parse(time.RFC3339Nano, document.State.StartedAt)
	if !exactProtectedContainerDocument(document, target.RequiredImageID, target.RequiredImageDigest,
		target.RequiredConfigDigest, target.MaintenanceGeneration, target.RequiredLabels, target.WorkerID, target.ModelProfileID) ||
		labels["com.teamaibox.node-id"] != ownership.NodeID ||
		generationErr != nil || workerGeneration < 1 || !retainedGeneration ||
		(target.RequiredStartSpecDigest != "" && (!digestID.MatchString("sha256:"+startSpec) ||
			"sha256:"+startSpec != target.RequiredStartSpecDigest)) ||
		!digestID.MatchString("sha256:"+document.ID) || startedErr != nil {
		return agent.WorkerState{}, fmt.Errorf("protected_office_identity_drift")
	}
	health := containerHealth(document)
	for _, dependent := range target.DependentContainers {
		state, err := r.inspectProtectedContainer(ctx, "dependent", dependent.ContainerName, dependent.RequiredImageID,
			dependent.RequiredImageDigest, dependent.RequiredConfigDigest, 0, dependent.RequiredLabels, "", "")
		if err != nil {
			return agent.WorkerState{}, err
		}
		if state.State != "running" || state.Health != "healthy" {
			health = "unhealthy"
		}
	}
	return agent.WorkerState{WorkerID: target.WorkerID, ModelProfileID: target.ModelProfileID,
		ContainerID: document.ID, Status: document.State.Status, Health: health, Image: document.Config.Image,
		PlacementClass: target.PlacementClass, MaintenanceGeneration: target.MaintenanceGeneration,
		ConfigDigest: target.RequiredConfigDigest, StartedAt: startedAt}, nil
}
