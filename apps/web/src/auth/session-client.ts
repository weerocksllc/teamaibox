import type { ProductLocale } from "../../../../packages/ui-system/src/locale-registry.mjs";
export type AuthenticatedSession = Readonly<{
  authenticated: true;
  csrfToken?: string;
  identity: {
    id: string;
    identityKind: "local_user";
    loginName: string;
    displayName: string;
    roles: string[];
    preferredLocale?: ProductLocale;
    preferredTheme?: "light" | "dark" | "system";
  };
  permissions: string[];
  teamMemberships: ReadonlyArray<{
    teamId: string;
    teamKey: string;
    teamDisplayName: string;
    roleKey: "team_admin" | "member" | "guest";
  }>;
  teamRoles: Readonly<Record<string, "manager" | "member" | "guest">>;
  preferences: {
    preferredLocale?: ProductLocale;
    preferredLocaleExplicit?: boolean;
    preferredTheme?: "light" | "dark" | "system";
  };
}>;

export type SetupStatus = Readonly<{ required: boolean; claimProtected: boolean; ownerRecoveryAvailable: boolean }>;
export type OwnerBootstrapResult = Readonly<{
  identity: AuthenticatedSession["identity"];
  recoveryCodes: string[];
}>;
export type OwnerRecoveryChallenge = Readonly<{ challenge: string; expiresAt: string }>;

export class SessionClientError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "SessionClientError";
    this.code = code;
    this.status = status;
  }
}

async function responseJson(response: Response) {
  try {
    return await response.json();
  } catch {
    throw new SessionClientError("invalid_response", "The service returned an invalid response", 502);
  }
}

async function acceptedJson(response: Response) {
  const value = await responseJson(response);
  if (!response.ok) {
    throw new SessionClientError(
      typeof value?.error?.code === "string" ? value.error.code : "request_failed",
      typeof value?.error?.message === "string" ? value.error.message : "The request failed",
      response.status,
    );
  }
  return value;
}

export async function loadAuthenticatedSession(): Promise<AuthenticatedSession | null> {
  const response = await fetch("/api/auth/session", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (response.status === 401) return null;
  return acceptedJson(response);
}

export async function loadSetupStatus(): Promise<SetupStatus> {
  const response = await fetch("/api/setup/status", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  return acceptedJson(response);
}

export async function bootstrapOwner(input: {
  loginName: string;
  displayName: string;
  password: string;
  setupToken: string;
}): Promise<OwnerBootstrapResult> {
  const response = await fetch("/api/setup/owner", {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return acceptedJson(response);
}

export async function signIn(loginName: string, password: string): Promise<AuthenticatedSession> {
  const response = await fetch("/api/auth/sign-in", {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ loginName, password }),
  });
  return acceptedJson(response);
}

export async function createOwnerRecoveryChallenge(): Promise<OwnerRecoveryChallenge> {
  const response = await fetch("/api/auth/owner-recovery/challenge", {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: "{}",
  });
  return acceptedJson(response);
}

export async function recoverOwner(input: {
  challenge: string;
  localRecoveryProof: string;
  recoveryCode: string;
  newPassword: string;
}): Promise<OwnerBootstrapResult> {
  const response = await fetch("/api/auth/owner-recovery", {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return acceptedJson(response);
}

function csrfToken() {
  const matches = document.cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("__Host-teamaibox-csrf="));
  if (matches.length !== 1) throw new SessionClientError("csrf_unavailable", "Session verification is unavailable", 401);
  return matches[0].slice(matches[0].indexOf("=") + 1);
}

async function protectedRequest(path: string, method: "POST" | "PATCH", body?: object, keepalive = false) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    keepalive,
    headers: {
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
      "x-csrf-token": csrfToken(),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return acceptedJson(response);
}

export async function signOut() {
  await protectedRequest("/api/auth/sign-out", "POST");
}

export async function updatePreferredLocale(locale: ProductLocale) {
  // These tiny preference writes should finish when the user immediately
  // opens another page. Do not apply this to ordinary business operations.
  await protectedRequest("/api/preferences/locale", "PATCH", { locale }, true);
  if (globalThis.__TEAM_AI_BOX_ACCOUNT_PREFERENCES__) {
    globalThis.__TEAM_AI_BOX_ACCOUNT_PREFERENCES__.preferredLocale = locale;
    globalThis.__TEAM_AI_BOX_ACCOUNT_PREFERENCES__.preferredLocaleExplicit = true;
  }
}

export async function updatePreferredTheme(theme: "light" | "dark" | "system") {
  await protectedRequest("/api/preferences/theme", "PATCH", { theme }, true);
}

export function installAuthenticatedSession(session: AuthenticatedSession, onSignedOut: () => void) {
  globalThis.__TEAM_AI_BOX_AUTHORIZATION__ = {
    identityKind: session.identity.identityKind,
    permissions: session.permissions,
  };
  globalThis.__TEAM_AI_BOX_ACCOUNT_PREFERENCES__ = {
    identityId: session.identity.id,
    displayName: session.identity.displayName,
    loginName: session.identity.loginName,
    roles: session.identity.roles,
    preferredLocale: session.preferences.preferredLocale,
    preferredLocaleExplicit: session.preferences.preferredLocaleExplicit === true,
    preferredTheme: session.preferences.preferredTheme,
  };
  globalThis.__TEAM_AI_BOX_PREFERENCE_TRANSPORT__ = {
    updatePreferredLocale,
    updatePreferredTheme,
  };
  globalThis.__TEAM_AI_BOX_SESSION_TRANSPORT__ = {
    async signOut() {
      await signOut();
      delete globalThis.__TEAM_AI_BOX_AUTHORIZATION__;
      delete globalThis.__TEAM_AI_BOX_ACCOUNT_PREFERENCES__;
      delete globalThis.__TEAM_AI_BOX_PREFERENCE_TRANSPORT__;
      delete globalThis.__TEAM_AI_BOX_SESSION_TRANSPORT__;
      onSignedOut();
    },
  };
}
