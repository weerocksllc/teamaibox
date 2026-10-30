import { delegatedScopeCatalogV1 } from "../../../../services/plugin-runtime/src/delegated-user-token-service.mjs";
import { versionSatisfies } from "../../../../services/plugin-runtime/src/plugin-import-service.mjs";
import { drawingIntentCatalogV2, drawingOrdinaryProfileV2 } from "./drawing-intent-router-v2.mjs";
import {releasedLocalization} from '../../../../packages/ui-system/src/official-localization.mjs';

const CORE_CAPABILITIES = Object.freeze({
  "encrypted-objects": "object-service",
  "object-references": "object-service",
  "resumable-transfers": "object-service",
  "file-metadata": "platform-api",
  "durable-jobs": "scheduler",
  "node-exclusive-leases": "scheduler",
  messaging: "messaging",
  "realtime-events": "event-bus",
});

function recent(value, clock, maximumAgeMilliseconds) {
  const observed = value ? new Date(value) : null;
  return Boolean(observed && Number.isFinite(observed.getTime())
    && observed <= clock && clock.getTime() - observed.getTime() <= maximumAgeMilliseconds);
}

function pluginHealthy(plugin, signal, route, clock, maximumAgeMilliseconds) {
  const slot = plugin.slotHealth;
  const slotHealthy = slot?.healthy === true || slot?.state === "healthy" || slot?.status === "healthy";
  const liveRouteHealthy = route?.healthy === true && recent(route.observedAt, clock, maximumAgeMilliseconds);
  const liveReadiness = route?.readinessChecked === true;
  return plugin.lifecycleState === "enabled" && plugin.installState === "healthy" && plugin.slotState === "active"
    && (liveReadiness ? liveRouteHealthy && route.version === plugin.currentVersion : slotHealthy)
    && (liveRouteHealthy || recent(plugin.slotUpdatedAt, clock, maximumAgeMilliseconds))
    && (liveRouteHealthy || !signal || (signal.state === "healthy" && recent(signal.observedAt, clock, maximumAgeMilliseconds)));
}

function requiredPermissions(manifest) {
  const requested = manifest?.permissions?.platformApiScopes ?? [];
  return [...new Set(requested.flatMap((scope) => {
    const permission = delegatedScopeCatalogV1[scope] ?? scope;
    return typeof permission === "string" ? [permission] : [];
  }))];
}

function manifestUi(manifest, pluginKey) {
  const ui = manifest?.ui ?? {};
  return Object.freeze({
    labelKey: typeof ui.displayNameKey === "string" ? ui.displayNameKey : null,
    descriptionKey: typeof ui.summaryKey === "string" ? ui.summaryKey : null,
    iconKey: typeof ui.icon === "string" ? ui.icon : "blocks",
    categoryKey: typeof ui.category === "string" ? ui.category : "professional",
    order: Number.isSafeInteger(ui.order) ? ui.order : 1000,
    fallbackLabel: pluginKey,
    official: manifest?.official === true,
    localization: releasedLocalization(pluginKey,manifest),
    themes: manifest?.themes ?? null,
  });
}

export function applicationStartupState(models, blockers) {
  if (!blockers.length) return "ready";
  if (blockers.some((blocker) => blocker !== "model_route_unavailable")) return "unavailable";
  const pending = models.filter((model) => !model.available);
  for (const state of ["failed", "retrying", "unavailable", "loading"]) {
    if (pending.some((model) => (model.startupState ?? "unavailable") === state)) return state;
  }
  return "unavailable";
}

export class ApplicationCatalogService {
  #repository;
  #routeSource;
  #builtInSource;
  #clock;
  #maximumHealthAgeMilliseconds;
  #drawingProfile;

  constructor({ repository, routeSource, builtInSource = null, clock = () => new Date(), maximumHealthAgeMilliseconds = 120_000, drawingProfile = null }) {
    if (!repository?.snapshot || !routeSource?.routes || (builtInSource !== null && !builtInSource?.applications)) throw new TypeError("Application catalog facts are required");
    if (typeof clock !== "function" || !Number.isSafeInteger(maximumHealthAgeMilliseconds) || maximumHealthAgeMilliseconds < 10_000 || maximumHealthAgeMilliseconds > 600_000) throw new TypeError("Application catalog health freshness policy is invalid");
    this.#repository = repository;
    this.#routeSource = routeSource;
    this.#builtInSource = builtInSource;
    this.#clock = clock;
    this.#maximumHealthAgeMilliseconds = maximumHealthAgeMilliseconds;
    this.#drawingProfile = drawingProfile;
  }

  async list({ context }) {
    if (!context?.permissions?.includes("application:catalog:view")) return Object.freeze({ schemaVersion: 1, applications: Object.freeze([]) });
    const [snapshot, routes, builtIns] = await Promise.all([
      this.#repository.snapshot(), this.#routeSource.routes(), this.#builtInSource?.applications() ?? [],
    ]);
    const plugins = new Map(snapshot.plugins.map((plugin) => [plugin.pluginKey, plugin]));
    const routeByPlugin = new Map(routes.map((route) => [route.pluginKey, route]));
    const capabilityByKey = new Map(snapshot.capabilities.map((capability) => [capability.capabilityKey, capability]));
    const healthByTarget = new Map(snapshot.health.map((health) => [`${health.targetKind}:${health.targetKey}`, health]));
    const permissions = new Set(context.permissions);
    const now = this.#clock();

    const pluginApplications = snapshot.plugins.flatMap((plugin) => {
      if (plugin.pluginType !== "application" || !plugin.currentVersion || !plugin.manifest) return [];
      const manifest = plugin.manifest;
      const blockers = [];
      const web = manifest.entryPoints?.web;
      const route = routeByPlugin.get(plugin.pluginKey);
      if (!route || typeof web?.path !== "string" || route.pathPrefix !== web.path || web.integration !== "iframe") blockers.push("route_unavailable");
      const pluginSignal = healthByTarget.get(`plugin:${plugin.pluginKey}`);
      if (!pluginHealthy(plugin, pluginSignal, route, now, this.#maximumHealthAgeMilliseconds)) blockers.push("plugin_unhealthy");

      const dependencies = (manifest.compatibility?.dependencies ?? []).map((dependency) => {
        const installed = plugins.get(dependency.pluginId);
        const dependencySignal = installed ? healthByTarget.get(`plugin:${installed.pluginKey}`) : null;
        const satisfied = Boolean(installed?.currentVersion
          && pluginHealthy(installed, dependencySignal, routeByPlugin.get(installed.pluginKey), now, this.#maximumHealthAgeMilliseconds)
          && versionSatisfies(installed.currentVersion, dependency.versionRange));
        if (!dependency.optional && !satisfied) blockers.push("dependency_unavailable");
        return Object.freeze({ pluginKey: dependency.pluginId, versionRange: dependency.versionRange, optional: dependency.optional, satisfied });
      });

      const models = [];
      const capabilities = (manifest.compatibility?.requiredCapabilities ?? []).map((capabilityKey) => {
        const compute = capabilityByKey.get(capabilityKey);
        const drawingCapability = plugin.pluginKey === "official.drawing" && capabilityKey === "image-generation";
        const drawingIntentRouter = drawingCapability ? drawingIntentCatalogV2(compute, {
          ordinaryProfile: this.#drawingProfile,
        }) : null;
        const drawingOrdinarySelection = drawingIntentRouter?.intents
          .find((intent) => intent.intentKey === "automatic" && intent.available === true) ?? null;
        const discloseProfiles = (values) => drawingCapability
          ? (values ?? []).filter((profile) => profile === (this.#drawingProfile?.profileKey ?? drawingOrdinaryProfileV2)) : (values ?? []);
        const coreTarget = CORE_CAPABILITIES[capabilityKey];
        const coreHealth = coreTarget ? healthByTarget.get(`core_service:${coreTarget}`) : null;
        const eligible = compute ? (compute.eligible ?? compute.certified) : false;
        const available = compute
          ? eligible && (drawingCapability
            ? Boolean(drawingOrdinarySelection)
            : (compute.localRoute || compute.providerRoute))
          : Boolean(coreHealth?.state === "healthy" && recent(coreHealth.observedAt, now, this.#maximumHealthAgeMilliseconds));
        if (compute) {
          const certifiedProfiles = discloseProfiles(compute.certifiedProfiles);
          const experimentalProfiles = discloseProfiles(compute.experimentalProfiles);
          const localRoutableProfiles = discloseProfiles(compute.localRoutableProfiles);
          const providerRoutableProfiles = discloseProfiles(compute.providerRoutableProfiles);
          const disclosedSelectedProfile = drawingCapability
            ? drawingOrdinarySelection?.selectedProfile ?? null
            : compute.selectedProfile ?? null;
          models.push(Object.freeze({
          capabilityKey,
          certifiedProfiles,
          experimentalProfiles,
          selectedProfile: disclosedSelectedProfile,
          selectedProfileId: available && compute.localRoute && disclosedSelectedProfile
            && disclosedSelectedProfile === compute.selectedProfile
            && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(compute.selectedProfileId ?? "")
            ? compute.selectedProfileId : null,
          selectedCertificationState: drawingCapability
            ? drawingOrdinarySelection?.certificationState ?? null
            : disclosedSelectedProfile === compute.selectedProfile
            ? compute.selectedCertificationState ?? null
            : disclosedSelectedProfile ? (certifiedProfiles.includes(disclosedSelectedProfile) ? "certified" : "validating") : null,
          routingClass: compute.experimental === true && compute.certified !== true ? "experimental" : "certified",
          route: drawingCapability
            ? (drawingOrdinarySelection ? "local" : null)
            : compute.localRoute ? "local" : compute.providerRoute ? "external" : null,
          localRoutableProfiles,
          providerRoutableProfiles,
          ...(drawingCapability
            ? { intentRouter: drawingIntentRouter } : {}),
          available,
          startupState: compute.startupState ?? (available ? "ready" : "unavailable"),
          }));
        }
        if (!available) blockers.push(compute ? "model_route_unavailable" : "platform_capability_unavailable");
        return Object.freeze({ capabilityKey, kind: compute ? "model" : "platform", available });
      });

      const needed = requiredPermissions(manifest);
      const authorized = needed.every((permission) => permissions.has(permission));
      if (!authorized) blockers.push("authorization_denied");
      const uniqueBlockers = Object.freeze([...new Set(blockers)]);
      return [Object.freeze({
        pluginKey: plugin.pluginKey,
        installedVersion: plugin.currentVersion,
        lifecycleState: plugin.lifecycleState,
        authorized,
        route: route && route.pathPrefix === web?.path ? Object.freeze({ pathPrefix: route.pathPrefix, integration: web.integration }) : null,
        dependencies: Object.freeze(dependencies),
        capabilities: Object.freeze(capabilities),
        models: Object.freeze(models),
        health: Object.freeze({
          state: pluginHealthy(plugin, pluginSignal, route, now, this.#maximumHealthAgeMilliseconds) ? "healthy" : "unavailable",
          observedAt: route?.observedAt ?? pluginSignal?.observedAt ?? plugin.slotUpdatedAt,
        }),
        ui: manifestUi(manifest, plugin.pluginKey),
        availability: uniqueBlockers.length === 0 ? "available" : "unavailable",
        startupState: applicationStartupState(models, uniqueBlockers),
        launchable: uniqueBlockers.length === 0,
        blockers: uniqueBlockers,
      })];
    });

    const builtInApplications = builtIns.map((application) => {
      const blockers = [];
      const needed = [...application.requiredPermissions];
      const authorized = needed.every((permission) => permissions.has(permission));
      if (!authorized) blockers.push("authorization_denied");
      const models = application.requiredCapabilities.map((capabilityKey) => {
        const compute = capabilityByKey.get(capabilityKey);
        const requiredProfile = compute?.protectedDefault ?? application.requiredModelProfiles?.[capabilityKey] ?? null;
        const certifiedProfiles = compute?.certifiedProfiles ?? [];
        const experimentalProfiles = compute?.experimentalProfiles ?? [];
        const localRoutableProfiles = compute?.localRoutableProfiles ?? [];
        const providerRoutableProfiles = compute?.providerRoutableProfiles ?? [];
        const profileEligible = requiredProfile === null
          ? Boolean(compute?.eligible ?? compute?.certified)
          : certifiedProfiles.includes(requiredProfile) || experimentalProfiles.includes(requiredProfile);
        const localRoute = requiredProfile === null ? compute?.localRoute === true : localRoutableProfiles.includes(requiredProfile);
        const providerRoute = requiredProfile === null ? compute?.providerRoute === true : providerRoutableProfiles.includes(requiredProfile);
        const available = Boolean(profileEligible && (localRoute || providerRoute));
        if (!available) blockers.push("model_route_unavailable");
        return Object.freeze({ capabilityKey, requiredProfile,
          certifiedProfiles: Object.freeze(certifiedProfiles), experimentalProfiles: Object.freeze(experimentalProfiles),
          selectedProfile: requiredProfile ?? compute?.selectedProfile ?? null,
          selectedCertificationState: requiredProfile === compute?.selectedProfile ? compute.selectedCertificationState ?? null
            : requiredProfile === null ? compute?.selectedCertificationState ?? null
            : certifiedProfiles.includes(requiredProfile) ? "certified"
              : experimentalProfiles.includes(requiredProfile) ? "experimental" : null,
          routingClass: requiredProfile !== null
            ? certifiedProfiles.includes(requiredProfile) ? "certified" : "experimental"
            : compute?.experimental === true && compute?.certified !== true ? "experimental" : "certified",
          route: localRoute ? "local" : providerRoute ? "external" : null, available,
          startupState: compute?.startupState ?? (available ? "ready" : "unavailable") });
      });
      for (const service of application.requiredCoreServices) {
        const health = healthByTarget.get(`core_service:${service}`);
        if (health?.state !== "healthy" || !recent(health.observedAt, now, this.#maximumHealthAgeMilliseconds)) blockers.push("platform_capability_unavailable");
      }
      const uniqueBlockers = Object.freeze([...new Set(blockers)]);
      return Object.freeze({
        pluginKey: application.applicationKey,
        installedVersion: application.installedVersion,
        lifecycleState: "enabled",
        authorized,
        route: application.route,
        dependencies: Object.freeze([]),
        capabilities: Object.freeze(application.requiredCapabilities.map((capabilityKey) => Object.freeze({ capabilityKey, kind: "model", available: models.find((model) => model.capabilityKey === capabilityKey).available }))),
        models: Object.freeze(models),
        health: Object.freeze({ state: uniqueBlockers.some((blocker) => blocker !== "authorization_denied") ? "unavailable" : "healthy", observedAt: null }),
        ui: Object.freeze({ ...application.ui,
          localization: releasedLocalization(application.applicationKey, application.ui),
        }),
        availability: uniqueBlockers.length === 0 ? "available" : "unavailable",
        startupState: applicationStartupState(models, uniqueBlockers),
        launchable: uniqueBlockers.length === 0,
        blockers: uniqueBlockers,
      });
    });
    return Object.freeze({ schemaVersion: 1, applications: Object.freeze([...builtInApplications, ...pluginApplications]) });
  }

  async resolveProxyRoute({ context, pluginKey }) {
    if (!/^[a-z][a-z0-9_.-]{1,127}$/.test(pluginKey ?? "")
      || !context?.permissions?.includes("application:catalog:view") || !this.#repository.getApplication) return null;
    // Authorization is fresh on every request. Do not invoke list(): it probes
    // all apps and the protected model set, unrelated to serving this asset.
    const plugin = await this.#repository.getApplication(pluginKey);
    const web = plugin?.manifest?.entryPoints?.web;
    if (plugin?.pluginKey !== pluginKey || plugin.pluginType !== "application" || !plugin.currentVersion
      || plugin.lifecycleState !== "enabled" || plugin.installState !== "healthy" || plugin.slotState !== "active"
      || !new Set(["blue", "green"]).has(plugin.activeSlot)
      || web?.integration !== "iframe" || web.path !== `/plugins/${pluginKey}`
      || !requiredPermissions(plugin.manifest).every((permission) => context.permissions.includes(permission))) return null;
    const route = (await this.#routeSource.routes({ pluginKey })).find((item) => item.pluginKey === pluginKey && item.pathPrefix === web.path);
    if (route?.healthy !== true || route.transport !== "node-agent-mtls-proxy"
      || !pluginHealthy(plugin, null, route, this.#clock(), this.#maximumHealthAgeMilliseconds)) return null;
    return Object.freeze({ schemaVersion: 1, pluginId: pluginKey, pathPrefix: route.pathPrefix,
      integration: "iframe", transport: "platform-authenticated-proxy" });
  }

  async fetchProxyContent({ context, pluginKey, method, path }) {
    const route = await this.resolveProxyRoute({ context, pluginKey });
    if (!route || !new Set(["GET", "HEAD"]).has(method) || typeof path !== "string"
      || !(path === route.pathPrefix || path.startsWith(route.pathPrefix + "/") || path.startsWith(route.pathPrefix + "?"))) return null;
    const content = await this.#routeSource.fetch?.({ pluginKey, method, path });
    if (!content || !Buffer.isBuffer(content.body) || !Number.isSafeInteger(content.status) || content.status < 200 || content.status > 599
      || !content.headers || typeof content.headers !== "object" || Array.isArray(content.headers)) return null;
    return Object.freeze({ status: content.status, headers: Object.freeze({ ...content.headers }), body: content.body });
  }
}
