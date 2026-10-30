const ADMIN_CONTROLS = Object.freeze({
  nodes: Object.freeze({ view: "node:view", manage: "node:manage" }),
  models: Object.freeze({ view: "model:view", manage: "model:manage" }),
  queues: Object.freeze({ view: "queue:view", manage: "queue:manage" }),
  providers: Object.freeze({ view: "provider:view", manage: "provider:manage" }),
  plugins: Object.freeze({ view: "plugin:view", manage: "plugin:manage" }),
  storage: Object.freeze({ view: "storage:view", manage: "storage:manage" }),
  sources: Object.freeze({ view: "source:view", manage: "source:manage" }),
  updates: Object.freeze({ view: "update:view", manage: "update:manage" }),
  encryption: Object.freeze({ view: "security:view", manage: "security:manage" }),
  operations: Object.freeze({ view: "operations:view", manage: "operations:manage" }),
});

export const adminControls = ADMIN_CONTROLS;

export async function requireAdminControl(authorization, {
  identityId,
  control,
  access = "manage",
  resource = { kind: "appliance", key: "*" },
  operation,
}) {
  if (!authorization || typeof authorization.require !== "function") {
    throw new TypeError("authorization service is required");
  }
  const policy = ADMIN_CONTROLS[control];
  if (!policy || !Object.hasOwn(policy, access)) throw new TypeError("unknown administrator control or access mode");
  return authorization.require({
    identityId,
    permission: policy[access],
    resource,
    operation: operation ?? `admin.${control}.${access}`,
  });
}
