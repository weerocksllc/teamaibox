import type { PluginLocalizationV1, PluginTheme, PluginThemesV1, TextDirection } from "./manifest-v1.js";

export type SemanticThemeTokenNameV1 =
  | "canvas" | "surface" | "surface-raised" | "surface-subtle" | "text" | "text-muted"
  | "border" | "border-strong" | "interactive" | "interactive-hover" | "on-interactive"
  | "selected-surface" | "selected-text" | "focus" | "disabled-surface" | "disabled-text"
  | "disabled-border" | "success" | "success-soft" | "warning" | "warning-soft" | "error"
  | "error-soft" | "info" | "info-soft" | "chart-1" | "chart-2" | "chart-3" | "chart-4"
  | "chart-5" | "chart-6" | "code-surface" | "code-text" | "log-info" | "log-warning"
  | "log-error" | "shadow-sm" | "shadow-lg";

export type SemanticThemeTokensV1 = Readonly<Record<SemanticThemeTokenNameV1, string>>;

export interface PluginPreferenceManifestV1 {
  readonly id: string;
  readonly official: boolean;
  readonly localization: PluginLocalizationV1;
  readonly themes: PluginThemesV1;
}

export type PluginPreferenceDisclosureV1 =
  | { readonly code: "locale-fallback"; readonly requested: string; readonly effective: string }
  | { readonly code: "direction-fallback"; readonly requested: TextDirection; readonly effective: TextDirection }
  | { readonly code: "theme-fallback"; readonly requested: PluginTheme; readonly effective: PluginTheme }
  | { readonly code: "live-updates-unavailable" };

export interface PluginPreferenceCompatibilityV1 {
  readonly pluginId: string;
  readonly requested: { readonly locale: string; readonly direction: TextDirection; readonly theme: PluginTheme };
  readonly effective: { readonly locale: string; readonly direction: TextDirection; readonly theme: PluginTheme };
  readonly compatibility: {
    readonly localeSupported: boolean;
    readonly directionSupported: boolean;
    readonly themeSupported: boolean;
    readonly liveUpdates: boolean;
  };
  readonly disclosures: readonly PluginPreferenceDisclosureV1[];
}

export interface PluginPreferenceSnapshotV1 extends PluginPreferenceCompatibilityV1 {
  readonly schemaVersion: 1;
  readonly type: "teamaibox.plugin-preferences/v1";
  readonly revision: number;
  readonly semanticTokens: SemanticThemeTokensV1;
}

export const pluginPreferenceMessageTypeV1: "teamaibox.plugin-preferences/v1";
export const semanticThemeTokenNamesV1: readonly SemanticThemeTokenNameV1[];
export function directionForLocaleV1(locale: string): TextDirection;
export function createSemanticThemeTokensV1(input: Readonly<Record<string, string>>): SemanticThemeTokensV1;
export function resolvePluginPreferenceCompatibilityV1(input: {
  readonly manifest: PluginPreferenceManifestV1;
  readonly locale: string;
  readonly direction: TextDirection;
  readonly theme: PluginTheme;
}): PluginPreferenceCompatibilityV1;
export function createPluginPreferenceSnapshotV1(input: {
  readonly manifest: PluginPreferenceManifestV1;
  readonly locale: string;
  readonly direction: TextDirection;
  readonly theme: PluginTheme;
  readonly tokenSets: Readonly<Record<PluginTheme, Readonly<Record<string, string>>>>;
  readonly revision: number;
}): PluginPreferenceSnapshotV1;
export function assertPluginPreferenceSnapshotV1(snapshot: unknown): PluginPreferenceSnapshotV1;
export function createPluginPreferenceChannelV1(initialSnapshot?: PluginPreferenceSnapshotV1): {
  current(): PluginPreferenceSnapshotV1 | null;
  subscribe(listener: (snapshot: PluginPreferenceSnapshotV1) => void, options?: { emitCurrent?: boolean }): () => boolean;
  publish(snapshot: PluginPreferenceSnapshotV1): PluginPreferenceSnapshotV1;
};
export function applyPluginPreferenceSnapshotV1(input: {
  currentDocument: Document;
  snapshot: PluginPreferenceSnapshotV1;
  cssVariablePrefix?: `--${string}-`;
}): PluginPreferenceSnapshotV1;
export function postPluginPreferenceSnapshotV1(input: {
  targetWindow: Pick<Window, "postMessage">;
  targetOrigin: string;
  snapshot: PluginPreferenceSnapshotV1;
}): void;
export function subscribePluginPreferenceMessagesV1(input: {
  currentWindow: Pick<Window, "addEventListener" | "removeEventListener">;
  hostWindow: Window;
  hostOrigin: string;
  onChange(snapshot: PluginPreferenceSnapshotV1): void;
}): () => void;
