/// <reference types="vite/client" />

declare module "*.css";

declare var __TEAM_AI_BOX_AUTHORIZATION__: {
  identityKind: "local_user" | "service_account";
  permissions: string[];
} | undefined;

declare var __TEAM_AI_BOX_ACCOUNT_PREFERENCES__: {
  identityId?: string;
  displayName?: string;
  loginName?: string;
  roles?: string[];
  preferredLocale?: import("../../../packages/ui-system/src/locale-registry.mjs").ProductLocale;
  preferredLocaleExplicit?: boolean;
  preferredTheme?: "light" | "dark" | "system";
} | undefined;

declare var __TEAM_AI_BOX_RUNTIME__: {
  apiBase: string;
  classification: "isolated-development-synthetic-only" | "internal" | "supported-authenticated";
  deploymentSlot: string;
  mode: "development" | "internal" | "release";
  releaseEvidenceEligible: boolean;
  releaseId: string;
  transport: "http" | "https";
} | undefined;

declare var __TEAM_AI_BOX_PREFERENCE_TRANSPORT__: {
  updatePreferredLocale(locale: import("../../../packages/ui-system/src/locale-registry.mjs").ProductLocale): Promise<void>;
  updatePreferredTheme(theme: "light" | "dark" | "system"): Promise<void>;
} | undefined;

declare var __TEAM_AI_BOX_SESSION_TRANSPORT__: {
  signOut(): Promise<void>;
} | undefined;
