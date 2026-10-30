export type PluginType = "ApplicationPlugin" | "ComputePlugin";
export type PluginArchitecture = "linux/arm64/v8";
export type PluginTheme = "light" | "dark";
export type TextDirection = "ltr" | "rtl";

export interface PluginPublisherV1 {
  readonly id: string;
  readonly displayName: string;
  readonly website?: string;
}

export interface PluginImageVariantV1 {
  readonly architecture: PluginArchitecture;
  readonly reference: string;
  readonly digest: `sha256:${string}`;
  readonly mediaType: "application/vnd.oci.image.manifest.v1+json";
}

export interface PluginImageV1 {
  readonly name: string;
  readonly role: "application" | "worker" | "migration" | "sidecar";
  readonly variants: readonly PluginImageVariantV1[];
}

export interface PluginApiRequirementV1 {
  readonly name: string;
  readonly versionRange: string;
  readonly access: "delegated-user" | "scheduler";
}

export interface PluginUiMetadataV1 {
  readonly displayNameKey: string;
  readonly summaryKey: string;
  readonly icon: string;
  readonly category: "collaboration" | "ai-application" | "professional-tool" | "infrastructure";
  readonly launchPath?: string;
  readonly order?: number;
}

export interface PluginLocalizationV1 {
  readonly supportedLocales: readonly string[];
  readonly fallbackLocale: string;
  readonly supportedDirections: readonly TextDirection[];
  readonly rtlReady: boolean;
}

export interface PluginThemesV1 {
  readonly supported: readonly PluginTheme[];
  readonly usesSemanticTokens: boolean;
  readonly livePreferenceEvents: boolean;
}

export interface PluginPermissionsV1 {
  readonly platformApiScopes: readonly string[];
  readonly delegatedUserToken: boolean;
  readonly network: {
    readonly mode: "none" | "allowlist";
    readonly egressHosts: readonly string[];
  };
  readonly objectNamespaces: readonly string[];
  readonly devices: readonly ("accelerator" | "video-codec" | "audio")[];
}

export interface PluginResourceEnvelopeV1 {
  readonly cpu: { readonly requestMillicores: number; readonly limitMillicores: number };
  readonly unifiedMemoryBytes: number;
  readonly ephemeralStorageBytes: number;
  readonly persistentStorageBytes: number;
  readonly network: { readonly ingressBitsPerSecond: number; readonly egressBitsPerSecond: number };
  readonly accelerator?: { readonly kind: "nvidia-gpu" | "nvidia-video-codec"; readonly units: number };
}

export interface PluginHealthProbeV1 {
  readonly path: string;
  readonly intervalSeconds: number;
  readonly timeoutSeconds: number;
  readonly failureThreshold: number;
}

export interface PluginMigrationV1 {
  readonly id: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly imageName: string;
  readonly transactional: boolean;
  readonly reversible: boolean;
}

export interface PluginCompatibilityV1 {
  readonly platform: string;
  readonly pluginApi: string;
  readonly runtime: "oci-linux-arm64-v1";
  readonly requiredCapabilities: readonly string[];
  readonly dependencies: readonly {
    readonly pluginId: string;
    readonly versionRange: string;
    readonly optional: boolean;
  }[];
}

export interface PluginManifestSignatureV1 {
  readonly format: "teamaibox.canonical-json/v1";
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  readonly payloadDigest: `sha256:${string}`;
  readonly value: string;
}

interface CommonPluginManifestV1 {
  readonly apiVersion: "teamaibox.io/plugin/v1";
  readonly id: string;
  readonly version: string;
  readonly official: boolean;
  readonly publisher: PluginPublisherV1;
  readonly architectures: readonly PluginArchitecture[];
  readonly images: readonly PluginImageV1[];
  readonly apis: readonly PluginApiRequirementV1[];
  readonly ui: PluginUiMetadataV1;
  readonly localization: PluginLocalizationV1;
  readonly themes: PluginThemesV1;
  readonly permissions: PluginPermissionsV1;
  readonly resources: PluginResourceEnvelopeV1;
  readonly health: {
    readonly startup: PluginHealthProbeV1;
    readonly readiness: PluginHealthProbeV1;
    readonly liveness: PluginHealthProbeV1;
  };
  readonly migrations: readonly PluginMigrationV1[];
  readonly compatibility: PluginCompatibilityV1;
  readonly signature: PluginManifestSignatureV1;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface ApplicationPluginManifestV1 extends CommonPluginManifestV1 {
  readonly type: "ApplicationPlugin";
  readonly entryPoints: {
    readonly web: { readonly path: string; readonly integration: "iframe" | "module" };
  };
  readonly ui: PluginUiMetadataV1 & { readonly launchPath: string };
}

export interface ComputePluginManifestV1 extends CommonPluginManifestV1 {
  readonly type: "ComputePlugin";
  readonly entryPoints: {
    readonly worker: {
      readonly protocol: "teamaibox.worker-control/v1";
      readonly capabilityRegistration: "scheduler-only";
    };
  };
}

export type PluginManifestV1 = ApplicationPluginManifestV1 | ComputePluginManifestV1;
