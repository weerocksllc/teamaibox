import {
  fallbackLocale,
  supportedLocales,
} from "../i18n.ts";

export const recentLocaleStorageKey = "teamaibox.recent-locale";

export function browserLocaleStorage(globalObject = globalThis) {
  try {
    return globalObject.localStorage;
  } catch {
    return undefined;
  }
}

function exactLocale(candidate) {
  return typeof candidate === "string" && supportedLocales.includes(candidate)
    ? candidate
    : null;
}

export function storedLocalePreference(storage = browserLocaleStorage()) {
  try {
    return exactLocale(storage?.getItem?.(recentLocaleStorageKey));
  } catch {
    return null;
  }
}

/**
 * @param {{accountLocale?: unknown, accountLocaleExplicit?: boolean, storage?: {getItem?: (key: string) => string | null}, browserLocales?: readonly string[]}} [options]
 */
export function resolveInitialLocale({
  accountLocale,
  accountLocaleExplicit = false,
  storage,
} = {}) {
  // This key has only ever been written by a manual language-menu action.
  const stored = storedLocalePreference(storage);
  if (stored) return stored;
  const account = accountLocaleExplicit ? exactLocale(accountLocale) : null;
  if (account) return account;
  // Browser and OS language are not user choices for this product.
  return fallbackLocale;
}

/**
 * @param {{locale?: unknown, storage?: {setItem?: (key: string, value: string) => void}, accountTransport?: {updatePreferredLocale?: (locale: import("../../../../packages/ui-system/src/locale-registry.mjs").ProductLocale) => Promise<void>}}} [options]
 */
export async function persistLocalePreference({ locale, storage, accountTransport } = {}) {
  const normalized = exactLocale(locale);
  if (!normalized) throw new TypeError("unsupported locale preference");
  try {
    storage?.setItem?.(recentLocaleStorageKey, normalized);
  } catch {
    // A device-local hint is optional; the authenticated account remains canonical.
  }
  if (accountTransport?.updatePreferredLocale) {
    await accountTransport.updatePreferredLocale(normalized);
  }
  return normalized;
}
