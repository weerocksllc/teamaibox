package docker

import (
	"context"
	"fmt"
	"net/http"
	"net/url"

	"teamaibox.local/node-agent/internal/agent"
)

func canonicalCompanionUpdate(change agent.ProtectedSetTransitionTarget) bool {
	return change.LegacyPreviousTarget == nil && len(change.DesiredCompanions) > 0 &&
		(change.PreviousTarget == nil || !transitionTargetsEqual(*change.PreviousTarget, change.DesiredTarget))
}

// Primary first, followed by its dependents. Separate identities allow replay
// after any individual rename without requiring an impossible half-renamed set.
func canonicalPriorMembers(change agent.ProtectedSetTransitionTarget) []agent.ExclusiveDrainTarget {
	if change.PreviousTarget == nil {
		return nil
	}
	primary := *change.PreviousTarget
	primary.DependentContainers = nil
	members := []agent.ExclusiveDrainTarget{primary}
	for _, value := range change.PreviousTarget.DependentContainers {
		members = append(members, agent.ExclusiveDrainTarget{
			TargetKey: "dependent", ContainerName: value.ContainerName,
			PlacementClass:  agent.PlacementProtectedResident,
			RequiredImageID: value.RequiredImageID, RequiredImageDigest: value.RequiredImageDigest,
			RequiredConfigDigest: value.RequiredConfigDigest, RequiredLabels: value.RequiredLabels,
		})
	}
	return members
}

func (r *EngineRuntime) canonicalMember(ctx context.Context, member agent.ExclusiveDrainTarget, name string) (inspectDocument, bool, error) {
	var doc inspectDocument
	err := r.request(ctx, http.MethodGet, "/containers/"+url.PathEscape(name)+"/json", nil, &doc, http.StatusOK)
	if engineNotFound(err) {
		return doc, false, nil
	}
	if err != nil {
		return doc, false, err
	}
	if !exactProtectedContainerDocument(doc, member.RequiredImageID, member.RequiredImageDigest,
		member.RequiredConfigDigest, member.MaintenanceGeneration, member.RequiredLabels, member.WorkerID, member.ModelProfileID) {
		return doc, true, fmt.Errorf("protected_set_transition_prior_identity_drift")
	}
	return doc, true, nil
}

func (r *EngineRuntime) inspectCanonicalCompanionUpdate(ctx context.Context, change agent.ProtectedSetTransitionTarget, backup string, desired bool) error {
	if _, err := r.exactTransitionImage(ctx, change.DesiredWorker, change.DesiredTarget); err != nil {
		return err
	}
	for _, spec := range change.DesiredCompanions {
		if err := r.inspectExactCompanionImage(ctx, spec); err != nil {
			return err
		}
	}
	if desired {
		if _, err := r.verifyDesiredTransition(ctx, change); err != nil {
			return err
		}
	}
	for index, member := range canonicalPriorMembers(change) {
		name := transitionLegacyBackupName(backup, index-1)
		if desired {
			doc, found, err := r.canonicalMember(ctx, member, name)
			if err != nil || !found || doc.State.Status == "running" {
				return fmt.Errorf("protected_set_transition_prior_identity_drift")
			}
		} else {
			if exists, err := r.protectedTransitionContainerExists(ctx, name); err != nil || exists {
				return fmt.Errorf("protected_set_transition_unowned_identity")
			}
			doc, found, err := r.canonicalMember(ctx, member, member.ContainerName)
			if err != nil || !found || !healthyRunningDocument(doc) {
				return fmt.Errorf("protected_set_transition_prior_identity_drift")
			}
		}
	}
	if !desired {
		owned := map[string]bool{}
		for _, member := range canonicalPriorMembers(change) {
			owned[member.ContainerName] = true
		}
		names := []string{change.DesiredTarget.ContainerName, backup}
		for _, spec := range change.DesiredCompanions {
			names = append(names, spec.ContainerName)
		}
		for _, name := range names {
			if !owned[name] {
				if exists, err := r.protectedTransitionContainerExists(ctx, name); err != nil || exists {
					return fmt.Errorf("protected_set_transition_unowned_identity")
				}
			}
		}
	}
	return nil
}

func (r *EngineRuntime) stageCanonicalCompanionUpdate(ctx context.Context, change agent.ProtectedSetTransitionTarget, ownership agent.Ownership, backup string) (agent.WorkerState, error) {
	if state, err := r.verifyDesiredTransition(ctx, change); err == nil {
		return state, r.inspectCanonicalCompanionUpdate(ctx, change, backup, true)
	}
	if _, err := r.exactTransitionImage(ctx, change.DesiredWorker, change.DesiredTarget); err != nil {
		return agent.WorkerState{}, err
	}
	for _, spec := range change.DesiredCompanions {
		if err := r.inspectExactCompanionImage(ctx, spec); err != nil {
			return agent.WorkerState{}, err
		}
	}
	members := canonicalPriorMembers(change)
	// Dependents stop before their primary. A stopped member or an already
	// renamed backup is an expected replay boundary, not a reason to stop others.
	order := []int{}
	for index := 1; index < len(members); index++ {
		order = append(order, index)
	}
	if len(members) > 0 {
		order = append(order, 0)
	}
	for _, index := range order {
		member := members[index]
		stored, found, err := r.canonicalMember(ctx, member, transitionLegacyBackupName(backup, index-1))
		if err != nil {
			return agent.WorkerState{}, err
		}
		if found {
			if stored.State.Status == "running" {
				return agent.WorkerState{}, fmt.Errorf("protected_set_transition_prior_identity_drift")
			}
			continue
		}
		doc, found, err := r.canonicalMember(ctx, member, member.ContainerName)
		if err != nil || !found {
			return agent.WorkerState{}, fmt.Errorf("protected_set_transition_prior_identity_drift")
		}
		if doc.State.Status == "running" {
			if err := r.stopContainer(ctx, doc.ID, 30); err != nil {
				return agent.WorkerState{}, err
			}
		}
	}
	for _, index := range order {
		member := members[index]
		name := transitionLegacyBackupName(backup, index-1)
		stored, found, err := r.canonicalMember(ctx, member, name)
		if err != nil {
			return agent.WorkerState{}, err
		}
		if found {
			if stored.State.Status == "running" {
				return agent.WorkerState{}, fmt.Errorf("protected_set_transition_prior_identity_drift")
			}
			continue
		}
		doc, found, err := r.canonicalMember(ctx, member, member.ContainerName)
		if err != nil || !found || doc.State.Status == "running" {
			return agent.WorkerState{}, fmt.Errorf("protected_set_transition_prior_identity_drift")
		}
		if err := r.renameProtectedTransitionContainer(ctx, doc.ID, name); err != nil {
			return agent.WorkerState{}, err
		}
	}
	if _, err := r.StartWorker(ctx, change.DesiredWorker, ownership); err != nil {
		return agent.WorkerState{}, err
	}
	target := change.DesiredTarget
	if _, err := r.waitProtectedContainerHealthy(ctx, target.TargetKey, target.ContainerName, target.RequiredImageID,
		target.RequiredImageDigest, target.RequiredConfigDigest, target.MaintenanceGeneration, target.RequiredLabels,
		target.WorkerID, target.ModelProfileID, protectedHealthWaitBound(change.DesiredWorker.HealthCheck)); err != nil {
		return agent.WorkerState{}, err
	}
	for _, spec := range change.DesiredCompanions {
		doc, found, err := r.inspectDesiredCompanionOptional(ctx, spec)
		if err != nil {
			return agent.WorkerState{}, err
		}
		if !found {
			if err := r.startProtectedCompanion(ctx, spec, ownership); err != nil {
				return agent.WorkerState{}, err
			}
		} else if doc.State.Status != "running" {
			if err := r.startExclusiveContainer(ctx, doc.ID); err != nil {
				return agent.WorkerState{}, err
			}
		}
		if err := r.waitDesiredCompanionHealthy(ctx, spec); err != nil {
			return agent.WorkerState{}, err
		}
	}
	return r.verifyDesiredTransition(ctx, change)
}

func (r *EngineRuntime) rollbackCanonicalCompanionUpdate(ctx context.Context, change agent.ProtectedSetTransitionTarget, backup string) error {
	members := canonicalPriorMembers(change)
	// A canonical name may still be the old member when failure preceded its
	// rename. Only remove a new member after proving its full desired spec.
	priorNames := map[string]agent.ExclusiveDrainTarget{}
	for _, member := range members {
		priorNames[member.ContainerName] = member
	}
	for index := len(change.DesiredCompanions) - 1; index >= 0; index-- {
		spec := change.DesiredCompanions[index]
		if member, ok := priorNames[spec.ContainerName]; ok {
			if _, found, err := r.canonicalMember(ctx, member, member.ContainerName); err == nil && found {
				continue
			}
		}
		if err := r.removeDesiredCompanions(ctx, []agent.ProtectedCompanionStartPayload{spec}); err != nil {
			return err
		}
	}
	priorAtCanonical := false
	if len(members) > 0 {
		_, found, err := r.canonicalMember(ctx, members[0], members[0].ContainerName)
		priorAtCanonical = err == nil && found
	}
	if !priorAtCanonical {
		if err := r.removeProtectedTransitionDesired(ctx, change.DesiredTarget); err != nil {
			return err
		}
	}
	// Restore every name first. The standard restoration primitive then starts
	// Worker first and Providers afterwards, keeping all original container IDs.
	for index, member := range members {
		name := transitionLegacyBackupName(backup, index-1)
		doc, found, err := r.canonicalMember(ctx, member, name)
		if err != nil {
			return err
		}
		if found {
			if doc.State.Status == "running" {
				return fmt.Errorf("protected_set_transition_prior_identity_drift")
			}
			if exists, err := r.protectedTransitionContainerExists(ctx, member.ContainerName); err != nil || exists {
				return fmt.Errorf("protected_set_transition_unowned_identity")
			}
			if err := r.renameProtectedTransitionContainer(ctx, doc.ID, member.ContainerName); err != nil {
				return err
			}
		} else if _, present, err := r.canonicalMember(ctx, member, member.ContainerName); err != nil || !present {
			return fmt.Errorf("protected_set_transition_prior_identity_drift")
		}
	}
	if change.PreviousTarget != nil {
		_, err := r.RestoreProtectedMaintenanceTarget(ctx, *change.PreviousTarget)
		return err
	}
	return nil
}

func (r *EngineRuntime) commitCanonicalCompanionUpdate(ctx context.Context, change agent.ProtectedSetTransitionTarget, backup string) error {
	if _, err := r.verifyDesiredTransition(ctx, change); err != nil {
		return err
	}
	var ids []string
	for index, member := range canonicalPriorMembers(change) {
		doc, found, err := r.canonicalMember(ctx, member, transitionLegacyBackupName(backup, index-1))
		if err != nil {
			return err
		}
		if !found {
			continue
		} // committed cleanup replay
		if doc.State.Status == "running" {
			return fmt.Errorf("protected_set_transition_prior_identity_drift")
		}
		ids = append(ids, doc.ID)
	}
	for index := len(ids) - 1; index >= 0; index-- {
		if err := r.request(ctx, http.MethodDelete, "/containers/"+url.PathEscape(ids[index]), nil, nil, http.StatusNoContent); err != nil {
			return err
		}
	}
	return nil
}
