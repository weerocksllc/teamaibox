// Fail-closed build fallback. The appliance Web boundary replaces this response
// dynamically with release/slot metadata and, only in isolated development,
// an explicitly configured browser preview authorization context.
globalThis.__TEAM_AI_BOX_RUNTIME__ = Object.freeze({
  apiBase: "/api",
  deploymentSlot: "unserved-build",
  mode: "release",
  releaseId: "unknown",
  transport: "https",
});
