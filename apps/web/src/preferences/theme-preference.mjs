export const recentThemeStorageKey = "teamaibox.recent-theme";
export const themeMetaColors = Object.freeze({ light: "#f6f8f8", dark: "#10191e" });

function exactPreference(candidate) {
  return candidate === "light" || candidate === "dark" || candidate === "system"
    ? candidate
    : null;
}

export function browserThemeStorage(globalObject = globalThis) {
  try {
    return globalObject.localStorage;
  } catch {
    return undefined;
  }
}

function storedPreference(storage) {
  try {
    return exactPreference(storage?.getItem?.(recentThemeStorageKey));
  } catch {
    return null;
  }
}

/**
 * @param {{accountTheme?: unknown, storage?: {getItem?: (key: string) => string | null}, systemDark?: boolean}} [options]
 */
export function resolveInitialTheme({ accountTheme, storage, systemDark = false } = {}) {
  const preference = resolveThemePreference({ accountTheme, storage });
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

/**
 * @param {{accountTheme?: unknown, storage?: {getItem?: (key: string) => string | null}}} [options]
 */
export function resolveThemePreference({ accountTheme, storage } = {}) {
  return exactPreference(accountTheme) ?? storedPreference(storage) ?? "system";
}

/**
 * @param {{theme?: unknown, storage?: {setItem?: (key: string, value: string) => void}, accountTransport?: {updatePreferredTheme?: (theme: "light" | "dark" | "system") => Promise<void>}}} [options]
 */
export async function persistThemePreference({ theme, storage, accountTransport } = {}) {
  const preference = exactPreference(theme);
  if (!preference) throw new TypeError("unsupported theme preference");
  try {
    storage?.setItem?.(recentThemeStorageKey, preference);
  } catch {
    // The account preference is canonical; device-local persistence is optional.
  }
  if (accountTransport?.updatePreferredTheme) {
    await accountTransport.updatePreferredTheme(preference);
  }
  return preference;
}
