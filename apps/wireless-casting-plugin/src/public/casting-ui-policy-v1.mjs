// Presentation only. Server authorization and resource admission remain authoritative.
export function outputSelectionV1({ availability, canView, activeOutputs = [] }) {
  const browser = canView === true && (availability?.outputs?.browser?.state === "available" || activeOutputs.includes("browser"));
  return { enabled: { browser }, checked: { browser } };
}

export function outputHealthLabelV1(session, sink) {
  const health = session.outputHealth;
  const value = health?.outputs?.[sink] ?? "unknown";
  if (health?.receiverHealthy === true && ["pairing", "paired"].includes(session.state) && value === "unavailable") return "waiting";
  return value;
}

export function workspaceVisibleV1({ capabilityReady, session }) {
  return capabilityReady || Boolean(session && ["initiator", "manager", "viewer"].includes(session.perspective));
}

export function videoVisibleV1({ joined, hasVideoTrack }) {
  // A transient playback hint must never hide an attached video: LiveKit's
  // adaptive stream treats a hidden element as a request to suspend video.
  return joined === true && hasVideoTrack === true;
}

// Polling snapshots are authoritative and versioned. A skipped revision does
// not require event replay; the newest snapshot deterministically suspends or
// resumes the already-authorized browser room. A rollback fails closed.
export function sourceReconciliationV1({ previousSessionId = null, previousRevision = null, session }) {
  if (!session?.id || ['stopping', 'stopped', 'failed', 'expired'].includes(session.state)
      || !Number.isSafeInteger(session.sourceStateRevision)
      || session.sourceStateRevision < 1) {
    return Object.freeze({ action: "reset", sessionId: null, revision: null });
  }
  if (previousSessionId !== session.id) {
    return Object.freeze({ action: session.sourceState === "disconnected" ? "suspend"
      : session.sourceState === "connected" ? "resume" : "unchanged",
    sessionId: session.id, revision: session.sourceStateRevision });
  }
  // During a control-service outage the API has no source snapshot and uses
  // unknown/revision 1. It is not an observed source revision, so retain the
  // last known revision instead of permanently rejecting this healthy page.
  if (session.sourceState === "unknown") {
    return Object.freeze({ action: "unchanged", sessionId: session.id,
      revision: previousRevision ?? session.sourceStateRevision });
  }
  if (Number.isSafeInteger(previousRevision) && session.sourceStateRevision < previousRevision) {
    return Object.freeze({ action: "reject", sessionId: session.id, revision: previousRevision });
  }
  if (session.sourceStateRevision === previousRevision) {
    return Object.freeze({ action: "unchanged", sessionId: session.id, revision: previousRevision });
  }
  return Object.freeze({ action: session.sourceState === "disconnected" ? "suspend"
    : session.sourceState === "connected" ? "resume" : "unchanged",
  sessionId: session.id, revision: session.sourceStateRevision });
}

// Starting browser output is the initiator's explicit viewing action. Merely
// opening this page, accepting an invitation or managing a session is not.
export function joinAfterStartV1({ session, canView }) {
  return canView === true && session?.perspective === "initiator"
    && session.outputSinks?.includes("browser") === true
    && ["pairing", "paired", "streaming"].includes(session.state);
}

export function presentationV1({ session, previouslyStreaming = false }) {
  const active = Boolean(session && ["requested", "starting", "pairing", "paired", "streaming", "stopping"].includes(session.state));
  const streaming = session?.state === "streaming" && !["disconnected", "waiting", "unknown"].includes(session?.sourceState);
  return { active, mode: streaming ? "streaming" : active ? "waiting" : "idle",
    disconnected: active && (session.sourceState === "disconnected" || session.state === "pairing" && previouslyStreaming),
    pairingVisible: active && !streaming && session.perspective === "initiator" };
}
