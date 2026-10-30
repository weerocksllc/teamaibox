import { assertPermissionKey } from "@teamaibox/authorization";

function permissionSet(context) {
  return new Set(Array.isArray(context?.permissions) ? context.permissions : []);
}

function validRequirements(item) {
  const all = item.requiredPermissions ?? [];
  const any = item.anyPermissions ?? [];
  try {
    for (const permission of [...all, ...any]) assertPermissionKey(permission);
  } catch {
    return null;
  }
  return { all, any };
}

export function isVisible(item, context) {
  const requirements = validRequirements(item);
  if (!requirements) return false;
  const available = permissionSet(context);
  return requirements.all.every((permission) => available.has(permission))
    && (requirements.any.length === 0 || requirements.any.some((permission) => available.has(permission)));
}

export function visibleNavigation(items, context) {
  return Object.freeze(items.flatMap((item) => {
    if (!isVisible(item, context)) return [];
    const children = item.children ? visibleNavigation(item.children, context) : undefined;
    if (item.children && children.length === 0 && !item.href) return [];
    return [{ ...item, ...(children ? { children } : {}) }];
  }));
}

export function routeBoundary(route, context) {
  if (isVisible(route, context)) return Object.freeze({ allowed: true, redirectTo: null });
  return Object.freeze({ allowed: false, redirectTo: "/forbidden" });
}

export const administratorNavigation = Object.freeze([
  { id: "users", href: "/admin/users", requiredPermissions: ["identity:view"] },
  { id: "roles", href: "/admin/roles", requiredPermissions: ["role:view"] },
  { id: "team", href: "/admin/team", requiredPermissions: ["team:manage"] },
  { id: "device", href: "/admin/device", requiredPermissions: ["node:view"] },
  { id: "phones", href: "/admin/phones", requiredPermissions: ["phone:manage"] },
  { id: "computers", href: "/admin/computers", requiredPermissions: ["computer:manage"] },
  { id: "models", href: "/admin/models", requiredPermissions: ["model:view"] },
  { id: "queues", href: "/admin/queues", requiredPermissions: ["queue:view"] },
  { id: "providers", href: "/admin/providers", requiredPermissions: ["provider:view"] },
  { id: "plugins", href: "/admin/plugins", requiredPermissions: ["plugin:view"] },
  { id: "storage", href: "/admin/storage", requiredPermissions: ["storage:view"] },
  { id: "sources", href: "/admin/sources", requiredPermissions: ["source:view"] },
  { id: "encryption", href: "/admin/encryption", requiredPermissions: ["security:view"] },
  { id: "updates", href: "/admin/updates", requiredPermissions: ["update:view"] },
  { id: "audit", href: "/admin/audit", requiredPermissions: ["audit:view"] },
]);

export const personalSettingsNavigation = Object.freeze([
  {
    id: "developer-credentials",
    href: "/settings/developer-credentials",
    requiredPermissions: ["developer_credential:create"],
  },
]);
