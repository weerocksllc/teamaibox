import { PlatformError } from "../../../../packages/observability/src/index.mjs";
import { supportedLocaleCodes } from "../../../../packages/ui-system/src/locale-registry.mjs";

export const supportedPreferenceLocales = supportedLocaleCodes;
export const supportedPreferenceThemes = Object.freeze(["light", "dark", "system"]);

export class IdentityPreferencesService {
  #repository;
  #audit;
  #clock;

  constructor({ repository, audit = async () => {}, clock = () => new Date() }) {
    if (!repository
      || typeof repository.findIdentity !== "function"
      || typeof repository.updatePreferredLocale !== "function"
      || typeof repository.updatePreferredTheme !== "function") {
      throw new TypeError("identity preference repository is required");
    }
    this.#repository = repository;
    this.#audit = audit;
    this.#clock = clock;
  }

  async preferredLocale({ context }) {
    if (!context?.identityId) throw new PlatformError("invalid_session", "Session is invalid", { status: 401 });
    const identity = await this.#repository.findIdentity(context.identityId);
    if (!identity || identity.status !== "active" || identity.identityKind !== "local_user") {
      throw new PlatformError("invalid_session", "Session is invalid", { status: 401 });
    }
    return identity.preferredLocale ?? "zh-CN";
  }

  async updatePreferredLocale({ context, identityId = context?.identityId, locale }) {
    if (!context?.identityId) throw new PlatformError("invalid_session", "Session is invalid", { status: 401 });
    if (identityId !== context.identityId) {
      throw new PlatformError("access_denied", "Users can update only their own preferences", { status: 403 });
    }
    if (!supportedPreferenceLocales.includes(locale)) {
      throw new PlatformError("invalid_locale", "Locale is not supported", { status: 400 });
    }
    const identity = await this.#repository.findIdentity(identityId);
    if (!identity || identity.status !== "active" || identity.identityKind !== "local_user") {
      throw new PlatformError("invalid_session", "Session is invalid", { status: 401 });
    }
    const updated = await this.#repository.updatePreferredLocale(identityId, locale, this.#clock());
    await this.#audit({
      action: "identity.preferred_locale_changed",
      occurredAt: this.#clock().toISOString(),
      actorIdentityId: identityId,
      previousLocale: identity.preferredLocale ?? "zh-CN",
      preferredLocale: updated.preferredLocale,
      success: true,
    });
    return Object.freeze({ identityId, preferredLocale: updated.preferredLocale });
  }

  async preferredTheme({ context }) {
    const identity = await this.#activeLocalIdentity(context);
    return identity.preferredTheme ?? "system";
  }

  async updatePreferredTheme({ context, identityId = context?.identityId, theme }) {
    if (!context?.identityId) throw new PlatformError("invalid_session", "Session is invalid", { status: 401 });
    if (identityId !== context.identityId) {
      throw new PlatformError("access_denied", "Users can update only their own preferences", { status: 403 });
    }
    if (!supportedPreferenceThemes.includes(theme)) {
      throw new PlatformError("invalid_theme", "Theme is not supported", { status: 400 });
    }
    const identity = await this.#activeLocalIdentity(context);
    const updated = await this.#repository.updatePreferredTheme(identityId, theme, this.#clock());
    await this.#audit({
      action: "identity.preferred_theme_changed",
      occurredAt: this.#clock().toISOString(),
      actorIdentityId: identityId,
      previousTheme: identity.preferredTheme ?? "system",
      preferredTheme: updated.preferredTheme,
      success: true,
    });
    return Object.freeze({ identityId, preferredTheme: updated.preferredTheme });
  }

  async #activeLocalIdentity(context) {
    if (!context?.identityId) throw new PlatformError("invalid_session", "Session is invalid", { status: 401 });
    const identity = await this.#repository.findIdentity(context.identityId);
    if (!identity || identity.status !== "active" || identity.identityKind !== "local_user") {
      throw new PlatformError("invalid_session", "Session is invalid", { status: 401 });
    }
    return identity;
  }
}
