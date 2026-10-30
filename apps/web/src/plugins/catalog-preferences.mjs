import {
  createPluginPreferenceSnapshotV1,
  createSemanticThemeTokensV1,
  pluginPreferenceMessageTypeV1,
  resolvePluginPreferenceCompatibilityV1,
  semanticThemeTokenNamesV1,
} from "@teamaibox/plugin-sdk/preferences-v1";
import { officialLocalization, releasedLocalization } from '../../../../packages/ui-system/src/official-localization.mjs';

export const officialPluginPreferenceDeclarationV1 = Object.freeze({
  official: true,
  localization: officialLocalization,
  themes: Object.freeze({
    supported: Object.freeze(["light", "dark"]),
    usesSemanticTokens: true,
    livePreferenceEvents: true,
  }),
});

export function catalogPreferenceManifestV1(app) {
  return {
    id: app.pluginKey,
    official: app.official === true,
    // The bundled UI release owns presentation capabilities. A retained import
    // or rolling-upgrade API response must not narrow its language support.
    localization: releasedLocalization(app.pluginKey, app),
    themes: app.themes,
  };
}

export function catalogPreferenceCompatibilityV1({ app, locale, direction, theme }) {
  return resolvePluginPreferenceCompatibilityV1({
    manifest: catalogPreferenceManifestV1(app), locale, direction, theme,
  });
}

export function readActiveSemanticThemeTokensV1({ element = globalThis.document?.documentElement, getStyle = globalThis.getComputedStyle } = {}) {
  if (!element || typeof getStyle !== "function") throw new TypeError("browser semantic token source is unavailable");
  const style = getStyle(element);
  return createSemanticThemeTokensV1(Object.fromEntries(
    semanticThemeTokenNamesV1.map((name) => [name, style.getPropertyValue(`--${name}`).trim()]),
  ));
}

export function publishOfficialCatalogPreferencesV1({ applications, locale, direction, theme, semanticTokens, revision, dispatch,
  onError = (error, app) => console.error('Unable to publish application preferences', app.pluginKey, error) }) {
  if (!Array.isArray(applications) || typeof dispatch !== "function") throw new TypeError("catalog preference publisher is invalid");
  const currentTokens = createSemanticThemeTokensV1(semanticTokens);
  const snapshots = [];
  for (const app of applications.filter((item) => item.official === true)) {
    try {
      const snapshot = createPluginPreferenceSnapshotV1({
        manifest: catalogPreferenceManifestV1(app),
        locale,
        direction,
        theme,
        // Official plugins support the active theme, so only the selected entry
        // is observed. The iframe launch host supplies both token sets.
        tokenSets: { light: currentTokens, dark: currentTokens },
        revision,
      });
      dispatch(pluginPreferenceMessageTypeV1, snapshot);
      snapshots.push(snapshot);
    } catch (error) {
      // Keep SDK validation strict, but one broken declaration must not throw
      // from the workbench-wide React effect and blank every application.
      onError(error, app);
    }
  }
  return Object.freeze(snapshots);
}
