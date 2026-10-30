import { permissionKeys } from "@teamaibox/authorization";

const knownPermissions = new Set(permissionKeys);
const permissionKeyPattern = /^[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_-]*)+$/;

export function authorizationFromBootstrap(value, { developmentFallback = false } = {}) {
  if (value === undefined && developmentFallback) {
    return Object.freeze({ identityKind: "local_user", permissions: permissionKeys });
  }
  if (!value || typeof value !== "object" || value.identityKind !== "local_user" || !Array.isArray(value.permissions)) {
    return Object.freeze({ identityKind: null, permissions: Object.freeze([]) });
  }
  if (value.permissions.some((permission) => typeof permission !== "string" || !permissionKeyPattern.test(permission))) {
    return Object.freeze({ identityKind: null, permissions: Object.freeze([]) });
  }
  return Object.freeze({
    identityKind: "local_user",
    // A newer API may advertise permissions this Web release does not yet use.
    // Ignore only those keys; never grant them or discard existing known access.
    permissions: Object.freeze([...new Set(value.permissions.filter((permission) => knownPermissions.has(permission)))].sort()),
  });
}
