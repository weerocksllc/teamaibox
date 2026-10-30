export type ApplicationCatalogFact = Readonly<{
  pluginKey: string;
  installedVersion: string;
  lifecycleState: string;
  authorized: boolean;
  route: null | Readonly<{ pathPrefix: string; integration: string }>;
  dependencies: ReadonlyArray<Readonly<{ pluginKey: string; versionRange: string; optional: boolean; satisfied: boolean }>>;
  capabilities: ReadonlyArray<Readonly<{ capabilityKey: string; kind: "model" | "platform"; available: boolean }>>;
  models: ReadonlyArray<Readonly<{ capabilityKey: string; certifiedProfiles: ReadonlyArray<string>; route: "local" | "external" | null; available: boolean }>>;
  health: Readonly<{ state: "healthy" | "unavailable"; observedAt: string | null }>;
  ui: Readonly<{
    labelKey: string | null; descriptionKey: string | null; iconKey: string; categoryKey: string; order: number; fallbackLabel: string;
    official: boolean;
    localization: null | Readonly<{ supportedLocales: ReadonlyArray<string>; fallbackLocale: string; supportedDirections: ReadonlyArray<"ltr" | "rtl">; rtlReady: boolean }>;
    themes: null | Readonly<{ supported: ReadonlyArray<"light" | "dark">; usesSemanticTokens: boolean; livePreferenceEvents: boolean }>;
  }>;
  availability: "available" | "unavailable";
  startupState?: "ready" | "loading" | "retrying" | "failed" | "unavailable";
  launchable: boolean;
  blockers: ReadonlyArray<string>;
}>;

export type ApplicationCatalogResponse = Readonly<{
  schemaVersion: 1;
  applications: ReadonlyArray<ApplicationCatalogFact>;
}>;

export class ApplicationCatalogApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
    this.name = "ApplicationCatalogApiError";
  }
}

function valid(value: any): value is ApplicationCatalogResponse {
  return value?.schemaVersion === 1 && Array.isArray(value.applications)
    && value.applications.every((application: any) => typeof application?.pluginKey === "string"
      && typeof application?.installedVersion === "string"
      && typeof application?.authorized === "boolean"
      && typeof application?.launchable === "boolean"
      && Array.isArray(application?.blockers));
}

export async function loadApplicationCatalog({ signal }: { signal?: AbortSignal } = {}): Promise<ApplicationCatalogResponse> {
  const response = await fetch("/api/v1/applications", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal,
  });
  let value: unknown;
  try { value = await response.json(); } catch {
    throw new ApplicationCatalogApiError("invalid_response", "Application catalog returned invalid JSON", 502);
  }
  if (!response.ok) {
    const error = value as any;
    throw new ApplicationCatalogApiError(error?.error?.code ?? "request_failed", error?.error?.message ?? "Application catalog request failed", response.status);
  }
  if (!valid(value)) throw new ApplicationCatalogApiError("invalid_response", "Application catalog response is invalid", 502);
  return value;
}
