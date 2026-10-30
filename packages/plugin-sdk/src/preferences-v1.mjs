const LOCALE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?$/;
const PLUGIN_ID = /^[a-z][a-z0-9.-]{2,127}$/;
const THEMES = new Set(["light", "dark"]);
const DIRECTIONS = new Set(["ltr", "rtl"]);
const RTL_LANGUAGES = new Set(["ar", "fa", "he", "ps", "ur"]);

export const pluginPreferenceMessageTypeV1 = "teamaibox.plugin-preferences/v1";

export const semanticThemeTokenNamesV1 = Object.freeze([
  "canvas", "surface", "surface-raised", "surface-subtle", "text", "text-muted",
  "border", "border-strong", "interactive", "interactive-hover", "on-interactive",
  "selected-surface", "selected-text", "focus", "disabled-surface", "disabled-text",
  "disabled-border", "success", "success-soft", "warning", "warning-soft", "error",
  "error-soft", "info", "info-soft", "chart-1", "chart-2", "chart-3", "chart-4",
  "chart-5", "chart-6", "code-surface", "code-text", "log-info", "log-warning",
  "log-error", "shadow-sm", "shadow-lg",
]);

function invalid(message) { throw new TypeError(message); }

function immutable(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutable(item)])));
  }
  return value;
}

function uniqueSupported(value, allowed, label) {
  if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length
    || value.some((item) => !allowed(item))) invalid(`${label} is invalid`);
  return value;
}

function preferenceDeclaration(manifest) {
  if (!manifest || typeof manifest !== "object" || !PLUGIN_ID.test(manifest.id ?? "")) {
    invalid("plugin preference manifest is invalid");
  }
  const localization = manifest.localization;
  const themes = manifest.themes;
  if (!localization || !themes) invalid("plugin preference declaration is missing");
  const locales = uniqueSupported(localization.supportedLocales, (item) => typeof item === "string" && LOCALE.test(item), "supported locales");
  if (!locales.includes(localization.fallbackLocale)) invalid("plugin fallback locale is invalid");
  const directions = uniqueSupported(localization.supportedDirections, (item) => DIRECTIONS.has(item), "supported directions");
  const supportedThemes = uniqueSupported(themes.supported, (item) => THEMES.has(item), "supported themes");
  if (localization.rtlReady !== directions.includes("rtl")
    || themes.usesSemanticTokens !== true || typeof themes.livePreferenceEvents !== "boolean") {
    invalid("plugin theme declaration is invalid");
  }
  if (manifest.official === true && (!["zh-CN", "en"].every((item) => locales.includes(item))
    || !["light", "dark"].every((item) => supportedThemes.includes(item)) || themes.livePreferenceEvents !== true)) {
    invalid("official plugin preference compatibility is incomplete");
  }
  return { locales, directions, supportedThemes };
}

export function directionForLocaleV1(locale) {
  if (typeof locale !== "string" || !LOCALE.test(locale)) invalid("locale is invalid");
  return RTL_LANGUAGES.has(locale.split("-")[0]) ? "rtl" : "ltr";
}

export function createSemanticThemeTokensV1(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("semantic theme tokens are invalid");
  const required = new Set(semanticThemeTokenNamesV1);
  const names = Object.keys(input);
  if (names.length !== required.size || names.some((name) => !required.has(name))) {
    invalid("semantic theme token set must contain exactly the v1 tokens");
  }
  const tokens = {};
  for (const name of semanticThemeTokenNamesV1) {
    const value = input[name];
    if (typeof value !== "string" || !value.trim() || value.length > 256) invalid(`semantic theme token ${name} is invalid`);
    tokens[name] = value.trim();
  }
  return Object.freeze(tokens);
}

export function resolvePluginPreferenceCompatibilityV1({ manifest, locale, direction, theme }) {
  const { locales, directions, supportedThemes } = preferenceDeclaration(manifest);
  if (typeof locale !== "string" || !LOCALE.test(locale) || !DIRECTIONS.has(direction) || !THEMES.has(theme)) {
    invalid("active platform preferences are invalid");
  }
  const localeSupported = locales.includes(locale);
  const effectiveLocale = localeSupported ? locale : manifest.localization.fallbackLocale;
  const desiredDirection = localeSupported ? direction : directionForLocaleV1(effectiveLocale);
  const directionSupported = directions.includes(desiredDirection);
  const effectiveDirection = directionSupported ? desiredDirection : directions[0];
  const themeSupported = supportedThemes.includes(theme);
  const effectiveTheme = themeSupported ? theme : supportedThemes[0];
  const liveUpdates = manifest.themes.livePreferenceEvents === true;
  const disclosures = [];
  if (!localeSupported) disclosures.push({ code: "locale-fallback", requested: locale, effective: effectiveLocale });
  if (!directionSupported) disclosures.push({ code: "direction-fallback", requested: desiredDirection, effective: effectiveDirection });
  if (!themeSupported) disclosures.push({ code: "theme-fallback", requested: theme, effective: effectiveTheme });
  if (!liveUpdates) disclosures.push({ code: "live-updates-unavailable" });
  if (manifest.official === true && disclosures.length) invalid("official plugin preference compatibility is incomplete");
  return immutable({
    pluginId: manifest.id,
    requested: { locale, direction, theme },
    effective: { locale: effectiveLocale, direction: effectiveDirection, theme: effectiveTheme },
    compatibility: { localeSupported, directionSupported, themeSupported, liveUpdates },
    disclosures,
  });
}

export function createPluginPreferenceSnapshotV1({ manifest, locale, direction, theme, tokenSets, revision }) {
  if (!Number.isSafeInteger(revision) || revision < 1) invalid("plugin preference revision is invalid");
  const compatibility = resolvePluginPreferenceCompatibilityV1({ manifest, locale, direction, theme });
  if (!tokenSets || typeof tokenSets !== "object") invalid("semantic theme token sets are missing");
  const semanticTokens = createSemanticThemeTokensV1(tokenSets[compatibility.effective.theme]);
  return immutable({
    schemaVersion: 1,
    type: pluginPreferenceMessageTypeV1,
    revision,
    ...compatibility,
    semanticTokens,
  });
}

export function assertPluginPreferenceSnapshotV1(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.type !== pluginPreferenceMessageTypeV1
    || !PLUGIN_ID.test(snapshot.pluginId ?? "") || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) {
    invalid("plugin preference snapshot is invalid");
  }
  if (typeof snapshot.requested?.locale !== "string" || !LOCALE.test(snapshot.requested.locale)
    || !DIRECTIONS.has(snapshot.requested?.direction) || !THEMES.has(snapshot.requested?.theme)
    || typeof snapshot.effective?.locale !== "string" || !LOCALE.test(snapshot.effective.locale)
    || !DIRECTIONS.has(snapshot.effective?.direction) || !THEMES.has(snapshot.effective?.theme)) {
    invalid("plugin preference values are invalid");
  }
  const semanticTokens = createSemanticThemeTokensV1(snapshot.semanticTokens);
  const compatibilityKeys = ["localeSupported", "directionSupported", "themeSupported", "liveUpdates"];
  if (!Array.isArray(snapshot.disclosures) || !snapshot.compatibility
    || compatibilityKeys.some((key) => typeof snapshot.compatibility[key] !== "boolean")) {
    invalid("plugin preference compatibility is invalid");
  }
  const disclosures = snapshot.disclosures.map((item) => {
    if (!item || typeof item !== "object") invalid("plugin preference disclosure is invalid");
    if (item.code === "live-updates-unavailable") return { code: item.code };
    if (item.code === "locale-fallback" && LOCALE.test(item.requested ?? "") && LOCALE.test(item.effective ?? "")) {
      return { code: item.code, requested: item.requested, effective: item.effective };
    }
    if (item.code === "direction-fallback" && DIRECTIONS.has(item.requested) && DIRECTIONS.has(item.effective)) {
      return { code: item.code, requested: item.requested, effective: item.effective };
    }
    if (item.code === "theme-fallback" && THEMES.has(item.requested) && THEMES.has(item.effective)) {
      return { code: item.code, requested: item.requested, effective: item.effective };
    }
    invalid("plugin preference disclosure is invalid");
  });
  const expected = [
    ...(!snapshot.compatibility.localeSupported ? ["locale-fallback"] : []),
    ...(!snapshot.compatibility.directionSupported ? ["direction-fallback"] : []),
    ...(!snapshot.compatibility.themeSupported ? ["theme-fallback"] : []),
    ...(!snapshot.compatibility.liveUpdates ? ["live-updates-unavailable"] : []),
  ];
  if (new Set(disclosures.map(({ code }) => code)).size !== disclosures.length
    || disclosures.map(({ code }) => code).join("|") !== expected.join("|")) {
    invalid("plugin preference disclosures do not match compatibility");
  }
  return immutable({
    schemaVersion: 1,
    type: pluginPreferenceMessageTypeV1,
    revision: snapshot.revision,
    pluginId: snapshot.pluginId,
    requested: {
      locale: snapshot.requested.locale,
      direction: snapshot.requested.direction,
      theme: snapshot.requested.theme,
    },
    effective: {
      locale: snapshot.effective.locale,
      direction: snapshot.effective.direction,
      theme: snapshot.effective.theme,
    },
    compatibility: Object.fromEntries(compatibilityKeys.map((key) => [key, snapshot.compatibility[key]])),
    disclosures,
    semanticTokens,
  });
}

export function createPluginPreferenceChannelV1(initialSnapshot) {
  let current = initialSnapshot === undefined ? null : assertPluginPreferenceSnapshotV1(initialSnapshot);
  const subscribers = new Set();
  return Object.freeze({
    current() { return current; },
    subscribe(listener, { emitCurrent = true } = {}) {
      if (typeof listener !== "function") invalid("plugin preference subscriber is invalid");
      subscribers.add(listener);
      if (emitCurrent && current) listener(current);
      return () => subscribers.delete(listener);
    },
    publish(snapshot) {
      const next = assertPluginPreferenceSnapshotV1(snapshot);
      if (current && (next.pluginId !== current.pluginId || next.revision <= current.revision)) {
        invalid("plugin preference snapshot is stale or belongs to another plugin");
      }
      current = next;
      for (const listener of [...subscribers]) listener(next);
      return next;
    },
  });
}

export function applyPluginPreferenceSnapshotV1({
  currentDocument,
  snapshot,
  cssVariablePrefix = "--teamaibox-",
}) {
  const next = assertPluginPreferenceSnapshotV1(snapshot);
  const root = currentDocument?.documentElement;
  if (!root || typeof root.setAttribute !== "function" || typeof root.style?.setProperty !== "function") {
    invalid("plugin preference document is invalid");
  }
  if (typeof cssVariablePrefix !== "string" || !/^--[a-z][a-z0-9-]{0,62}-$/.test(cssVariablePrefix)) {
    invalid("plugin semantic token CSS prefix is invalid");
  }
  root.setAttribute("lang", next.effective.locale);
  root.setAttribute("dir", next.effective.direction);
  root.setAttribute("data-theme", next.effective.theme);
  root.setAttribute("data-plugin-preference-revision", String(next.revision));
  for (const name of semanticThemeTokenNamesV1) {
    root.style.setProperty(`${cssVariablePrefix}${name}`, next.semanticTokens[name]);
  }
  return next;
}

function exactOrigin(value) {
  let origin;
  try { origin = new URL(value).origin; } catch { invalid("plugin host origin must be an exact HTTP(S) origin"); }
  if (origin === "null" || origin !== value || !new Set(["http:", "https:"]).has(new URL(value).protocol)) {
    invalid("plugin host origin must be an exact HTTP(S) origin");
  }
  return origin;
}

export function postPluginPreferenceSnapshotV1({ targetWindow, targetOrigin, snapshot }) {
  if (!targetWindow || typeof targetWindow.postMessage !== "function") invalid("plugin target window is invalid");
  const origin = exactOrigin(targetOrigin);
  const message = assertPluginPreferenceSnapshotV1(snapshot);
  targetWindow.postMessage(message, origin);
}

export function subscribePluginPreferenceMessagesV1({ currentWindow, hostWindow, hostOrigin, onChange }) {
  if (!currentWindow || typeof currentWindow.addEventListener !== "function" || typeof currentWindow.removeEventListener !== "function"
    || !hostWindow || typeof onChange !== "function") invalid("plugin preference message subscriber is invalid");
  const origin = exactOrigin(hostOrigin);
  const listener = (event) => {
    if (event.source !== hostWindow || event.origin !== origin || event.data?.type !== pluginPreferenceMessageTypeV1) return;
    onChange(assertPluginPreferenceSnapshotV1(event.data));
  };
  currentWindow.addEventListener("message", listener);
  return () => currentWindow.removeEventListener("message", listener);
}
