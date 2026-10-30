const permissionList = [
  "application:catalog:view",
  "application:catalog:manage",
  "ai:invoke",
  "audit:view",
  "cast:use",
  "cast:share",
  "cast:view",
  "cast:manage",
  "phone:use",
  "phone:manage",
  "computer:use",
  "computer:manage",
  "developer_credential:create",
  "diagnostic_sensitive:view",
  "file:read",
  "file:write",
  "file:share",
  "file:manage",
  "identity:view",
  "identity:manage",
  "message:read",
  "message:write",
  "message:manage",
  "model:view",
  "model:manage",
  "node:view",
  "node:manage",
  "object_reference:revoke:any",
  "operations:view",
  "operations:manage",
  "plugin:view",
  "plugin:manage",
  "provider:view",
  "provider:manage",
  "queue:view",
  "queue:manage",
  "resource_policy:view",
  "resource_policy:manage",
  "role:view",
  "role:manage",
  "security:view",
  "security:manage",
  "service_credential:manage",
  "source:view",
  "source:manage",
  "storage:view",
  "storage:manage",
  "task:own:view",
  "task:own:manage",
  "team:view",
  "team:manage",
  "update:view",
  "update:manage",
];

export const permissionKeys = Object.freeze([...permissionList]);
const knownPermissions = new Set(permissionKeys);

const ordinaryUse = [
  "application:catalog:view",
  "ai:invoke",
  "message:read",
  "message:write",
  "file:read",
  "file:write",
  "task:own:view",
  "task:own:manage",
  "team:view",
  "cast:use",
  "cast:view",
  "phone:use",
  "computer:use",
];

const roleDefinitions = {
  owner: {
    allowedScopes: ["appliance"],
    permissions: permissionList,
  },
  system_admin: {
    allowedScopes: ["appliance"],
    permissions: [
      "identity:view", "identity:manage", "role:view", "role:manage",
      "service_credential:manage", "security:view", "security:manage",
      "storage:view", "storage:manage", "source:view", "source:manage",
      "object_reference:revoke:any",
      "update:view", "update:manage",
      "audit:view", "node:view", "operations:view", "operations:manage",
      "diagnostic_sensitive:view", "application:catalog:view", "cast:manage",
      "phone:manage",
      "computer:manage",
    ],
  },
  compute_admin: {
    allowedScopes: ["appliance"],
    permissions: [
      ...ordinaryUse, "node:view", "node:manage", "resource_policy:view",
      "resource_policy:manage", "model:view", "model:manage",
      "queue:view", "queue:manage", "provider:view",
      "provider:manage", "audit:view", "operations:view", "operations:manage",
      "cast:manage",
      "phone:manage",
      "computer:manage",
    ],
  },
  application_admin: {
    allowedScopes: ["appliance"],
    permissions: [
      ...ordinaryUse, "plugin:view", "plugin:manage",
      "application:catalog:manage", "audit:view",
    ],
  },
  developer: {
    allowedScopes: ["appliance"],
    permissions: [
      ...ordinaryUse, "developer_credential:create",
    ],
  },
  team_admin: {
    allowedScopes: ["appliance", "team"],
    permissions: [
      ...ordinaryUse, "team:manage", "message:manage", "file:share", "file:manage",
      "object_reference:revoke:any", "cast:share",
    ],
  },
  member: {
    allowedScopes: ["appliance", "team"],
    permissions: ordinaryUse,
  },
  guest: {
    allowedScopes: ["appliance", "team"],
    permissions: [
      "application:catalog:view", "message:read", "file:read", "team:view", "cast:view",
    ],
  },
};

export const roles = Object.freeze(Object.fromEntries(
  Object.entries(roleDefinitions).map(([key, value]) => [key, Object.freeze({
    key,
    allowedScopes: Object.freeze([...value.allowedScopes]),
    permissions: Object.freeze([...new Set(value.permissions)]),
  })]),
));

export function assertPermissionKey(permission) {
  if (!knownPermissions.has(permission)) {
    throw new TypeError(`unknown permission key: ${String(permission)}`);
  }
  return permission;
}

function normalizedResource(resource = { kind: "appliance", key: "*" }) {
  const kind = resource?.kind ?? "appliance";
  const key = resource?.key ?? (kind === "appliance" ? "*" : null);
  if (typeof kind !== "string" || !/^[a-z][a-z0-9_.-]{1,63}$/.test(kind)) {
    throw new TypeError("authorization resource kind is invalid");
  }
  if (typeof key !== "string" || key.length < 1 || key.length > 256) {
    throw new TypeError("authorization resource key is invalid");
  }
  return { kind, key };
}

function activeAt(record, now) {
  return !record.revokedAt && (!record.expiresAt || new Date(record.expiresAt) > now);
}

function bindingApplies(binding, resource, now) {
  if (!activeAt(binding, now)) return false;
  if (binding.scopeKind === "appliance" && binding.scopeKey === "*") return true;
  return binding.scopeKind === resource.kind && binding.scopeKey === resource.key;
}

function grantApplies(grant, permission, resource, now) {
  if (!activeAt(grant, now) || grant.permissionKey !== permission) return false;
  if (grant.resourceKind === "appliance" && grant.resourceKey === "*") return true;
  return grant.resourceKind === resource.kind && grant.resourceKey === resource.key;
}

export function evaluateAuthorization({
  principal,
  permission,
  resource,
  now = new Date(),
}) {
  assertPermissionKey(permission);
  const target = normalizedResource(resource);
  if (!principal || principal.status !== "active") {
    return Object.freeze({ allowed: false, reason: "principal_unavailable", permission, resource: target });
  }

  if (principal.identityKind === "service_account") {
    const allowed = (principal.serviceGrants ?? []).some((grant) =>
      grantApplies(grant, permission, target, now),
    );
    return Object.freeze({
      allowed,
      reason: allowed ? "service_grant" : "service_scope_denied",
      permission,
      resource: target,
    });
  }

  if (principal.identityKind !== "local_user") {
    return Object.freeze({ allowed: false, reason: "unsupported_principal", permission, resource: target });
  }

  for (const binding of principal.roleBindings ?? []) {
    const role = roles[binding.roleKey];
    if (!role || !role.allowedScopes.includes(binding.scopeKind)) continue;
    if (bindingApplies(binding, target, now) && role.permissions.includes(permission)) {
      return Object.freeze({ allowed: true, reason: `role:${role.key}`, permission, resource: target });
    }
  }
  return Object.freeze({ allowed: false, reason: "role_scope_denied", permission, resource: target });
}

export function grantedPermissions({ principal, resource, now = new Date() }) {
  return Object.freeze(permissionKeys.filter((permission) =>
    evaluateAuthorization({ principal, permission, resource, now }).allowed,
  ));
}

export function principalFromRoleKeys(identity, roleKeys, scope = { kind: "appliance", key: "*" }) {
  return {
    id: identity.id,
    status: identity.status,
    identityKind: identity.identityKind ?? "local_user",
    roleBindings: [...new Set(roleKeys ?? [])].map((roleKey) => ({
      roleKey,
      scopeKind: scope.kind,
      scopeKey: scope.key,
      expiresAt: null,
    })),
    serviceGrants: [],
  };
}
