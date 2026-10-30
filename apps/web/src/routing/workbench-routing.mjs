const ADMIN_PREFIX = "/admin";
const APPLICATION_PREFIX = "/apps";
const DEFAULT_ADMIN_ITEM = "overview";
const ADMIN_ITEM_PATTERN = /^[a-z][a-z0-9-]*$/;
const APPLICATION_SLUG_PATTERN = /^[a-z][a-z0-9.-]*$/;

export function parseWorkbenchRoute(pathname) {
  const normalized = typeof pathname === "string" && pathname.startsWith("/")
    ? pathname.replace(/\/+$/, "") || "/"
    : "/";

  if (normalized === ADMIN_PREFIX) {
    return { surface: "admin", adminItem: DEFAULT_ADMIN_ITEM, applicationPluginKey: null };
  }

  if (normalized.startsWith(`${ADMIN_PREFIX}/`)) {
    const segment = normalized.slice(ADMIN_PREFIX.length + 1).split("/", 1)[0];
    return {
      surface: "admin",
      adminItem: segment === "nodes" ? "device" : ADMIN_ITEM_PATTERN.test(segment) ? segment : DEFAULT_ADMIN_ITEM,
      applicationPluginKey: null,
    };
  }

  if (normalized.startsWith(`${APPLICATION_PREFIX}/`)) {
    const path = normalized.slice(APPLICATION_PREFIX.length + 1);
    const slug = path.includes("/") ? "" : path;
    return {
      surface: "workbench",
      adminItem: DEFAULT_ADMIN_ITEM,
      applicationPluginKey: APPLICATION_SLUG_PATTERN.test(slug)
        ? (slug.includes(".") ? slug : `official.${slug}`)
        : null,
    };
  }

  return { surface: "workbench", adminItem: DEFAULT_ADMIN_ITEM, applicationPluginKey: null };
}

export function workbenchRoute() {
  return "/";
}

export function applicationRoute(pluginKey) {
  const candidate = typeof pluginKey === "string" && pluginKey.startsWith("official.")
    ? pluginKey.slice("official.".length)
    : pluginKey;
  return typeof candidate === "string" && APPLICATION_SLUG_PATTERN.test(candidate)
    ? `${APPLICATION_PREFIX}/${candidate}`
    : workbenchRoute();
}

export function adminRoute(adminItem) {
  const safeItem = typeof adminItem === "string" && ADMIN_ITEM_PATTERN.test(adminItem)
    ? adminItem
    : DEFAULT_ADMIN_ITEM;
  return safeItem === DEFAULT_ADMIN_ITEM ? ADMIN_PREFIX : `${ADMIN_PREFIX}/${safeItem}`;
}
