import { isVisible } from "../authorization/view-policy.mjs";

const KEY = /^[a-z][a-z0-9_.-]{1,127}$/;

function assertKey(value, label) {
  if (typeof value !== "string" || !KEY.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function catalogApp(app) {
  assertKey(app.pluginKey, "plugin key");
  assertKey(app.categoryKey, "category key");
  assertKey(app.labelKey, "application label key");
  if (typeof app.descriptionKey !== "string" || !KEY.test(app.descriptionKey)) {
    throw new TypeError("application description key is invalid");
  }
  if (typeof app.iconKey !== "string" || !KEY.test(app.iconKey)) throw new TypeError("application icon key is invalid");
  return Object.freeze({ ...app });
}

export function applicationsFromCatalogFacts(facts) {
  if (!Array.isArray(facts)) throw new TypeError("application facts must be an array");
  return Object.freeze(facts.map((fact) => catalogApp({
    pluginKey: fact.pluginKey,
    categoryKey: ({"professional-tool":"professional"})[fact.ui?.categoryKey] ?? fact.ui?.categoryKey,
    labelKey: fact.ui?.labelKey ?? "applications.dynamic_name",
    descriptionKey: fact.ui?.descriptionKey ?? "applications.dynamic_description",
    iconKey: fact.ui?.iconKey ?? "blocks",
    fallbackLabel: fact.ui?.fallbackLabel ?? fact.pluginKey,
    enabled: true,
    order: fact.ui?.order ?? 1000,
    requiredPermissions: [],
    runtime: Object.freeze({ ...fact }),
  })));
}

// Entry readiness may briefly change during control-service recovery. Keep an
// already-open workspace alive, but never preserve revoked/removed access.
export function reconcileOpenApplication(current, target, requestedPluginKey) {
  if (target?.runtime?.authorized !== true || target.runtime.lifecycleState !== "enabled") return null;
  if (current?.pluginKey === requestedPluginKey) return current;
  return target?.runtime?.launchable === true ? target : null;
}

export function buildWorkbenchCatalog({ categories, applications, authorization }) {
  const categoryKeys = new Set();
  const configured = categories.map((category) => {
    assertKey(category.key, "category key");
    assertKey(category.labelKey, "category label key");
    if (categoryKeys.has(category.key)) throw new TypeError(`duplicate category: ${category.key}`);
    categoryKeys.add(category.key);
    return Object.freeze({ ...category, order: Number.isFinite(category.order) ? category.order : 1000 });
  });

  const pluginKeys = new Set();
  const enabled = applications.flatMap((application) => {
    const app = catalogApp(application);
    if (pluginKeys.has(app.pluginKey)) throw new TypeError(`duplicate application plugin: ${app.pluginKey}`);
    pluginKeys.add(app.pluginKey);
    if (!categoryKeys.has(app.categoryKey) || app.enabled !== true || !app.runtime?.authorized || !isVisible(app, authorization)) return [];
    return [app];
  });

  return Object.freeze(configured
    .sort((left, right) => left.order - right.order || left.key.localeCompare(right.key))
    .flatMap((category) => {
      const apps = enabled
        .filter((app) => app.categoryKey === category.key)
        .sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000)
          || left.pluginKey.localeCompare(right.pluginKey));
      return apps.length === 0 ? [] : [Object.freeze({ ...category, applications: Object.freeze(apps) })];
    }));
}

export function searchWorkbenchCatalog(groups, query, translate) {
  const normalized = String(query ?? "").normalize("NFKC").trim().toLocaleLowerCase();
  if (!normalized) return Object.freeze(groups.flatMap((group) => group.applications));
  return Object.freeze(groups.flatMap((group) => group.applications).filter((app) => {
    const label = translate(app.labelKey);
    const description = translate(app.descriptionKey);
    const haystack = [label === app.labelKey ? app.fallbackLabel : label, description === app.descriptionKey ? app.fallbackLabel : description, app.pluginKey]
      .join(" ")
      .normalize("NFKC")
      .toLocaleLowerCase();
    return haystack.includes(normalized);
  }));
}
