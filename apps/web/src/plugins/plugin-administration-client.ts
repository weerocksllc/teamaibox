export type PluginImport = Readonly<{
  schemaVersion: 1; pluginId: string; pluginType: "ApplicationPlugin" | "ComputePlugin"; version: string;
  sourceKind: "marketplace" | "private-registry" | "offline-bundle"; manifestPayloadDigest: string;
  bundlePayloadDigest: string; imageDigests: string[]; supplyChain: Readonly<Record<string, unknown>>;
  state: "verified"; verifiedAt: string;
}>;
export type ManagedPlugin = Readonly<{
  pluginId: string; pluginType: "ApplicationPlugin" | "ComputePlugin"; publisherId: string;
  protectedOfficial: boolean; lifecycleState: "discovered" | "staged" | "enabled" | "disabled" | "failed" | "uninstalled";
  currentVersion: string | null; activeSlot: "blue" | "green" | null; generation: number;
  dataRetentionState: string | null; versions: ReadonlyArray<Readonly<{ version: string; installState: string; slot: string | null;
    health: Readonly<Record<string, unknown>> | null; activatedAt: string | null; retiredAt: string | null; failedAt: string | null }>>;
  updatedAt: string | null;
}>;
export type PluginAdministration = Readonly<{
  object: "plugin_administration"; architecture: "linux/arm64/v8";
  supportedPluginTypes: ReadonlyArray<"ApplicationPlugin" | "ComputePlugin">;
  supportedSources: ReadonlyArray<"marketplace" | "private-registry" | "offline-bundle">;
  imports: PluginImport[]; plugins: ManagedPlugin[];
}>;

export class PluginAdministrationApiError extends Error {
  constructor(public code: string, message: string, public status: number, public details: Readonly<Record<string, unknown>> = {}) {
    super(message); this.name = "PluginAdministrationApiError";
  }
}

async function accepted(response: Response) {
  let value: any; try { value = await response.json(); } catch { throw new PluginAdministrationApiError("invalid_response", "Plugin administration returned an invalid response", 502); }
  if (!response.ok) throw new PluginAdministrationApiError(value?.error?.code ?? "request_failed", value?.error?.message ?? "Plugin request failed", response.status, value?.error?.details ?? {});
  return value;
}
function csrfToken() {
  const values = document.cookie.split(";").map((part) => part.trim()).filter((part) => part.startsWith("__Host-teamaibox-csrf="));
  if (values.length !== 1) throw new PluginAdministrationApiError("csrf_unavailable", "Session verification is unavailable", 401);
  return decodeURIComponent(values[0].slice("__Host-teamaibox-csrf=".length));
}
async function request(path: string, method = "GET", body?: unknown) {
  return accepted(await fetch(path, { method, credentials: "same-origin", headers: { accept: "application/json",
    ...(body === undefined ? {} : { "content-type": "application/json", "x-csrf-token": csrfToken() }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}

export function loadPluginAdministration(): Promise<PluginAdministration> { return request("/api/v1/admin/plugins"); }
export function importPlugin(input: Record<string, unknown>): Promise<PluginImport> { return request("/api/v1/admin/plugins/imports", "POST", input); }
export function operatePlugin(pluginId: string, operation: "install" | "enable" | "disable" | "upgrade" | "uninstall", version?: string): Promise<ManagedPlugin> {
  return request(`/api/v1/admin/plugins/${encodeURIComponent(pluginId)}/${operation}`, "POST", {
    operationKey: `plugin-${operation}-${crypto.randomUUID()}`,
    ...(version ? { version } : {}),
  });
}
