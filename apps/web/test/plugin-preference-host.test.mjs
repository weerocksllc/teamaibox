import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { semanticThemeTokenNamesV1 } from "../../../packages/plugin-sdk/src/preferences-v1.mjs";
import {supportedLocaleCodes} from '../../../packages/ui-system/src/locale-registry.mjs';
import {
  catalogPreferenceCompatibilityV1,
  publishOfficialCatalogPreferencesV1,
  readActiveSemanticThemeTokensV1,
} from "../src/plugins/catalog-preferences.mjs";
const tokens = Object.fromEntries(semanticThemeTokenNamesV1.map((name) => [name, `value-${name}`]));

test("every official container application declares both locales, Light/Dark, semantic tokens, and live events", async () => {
  const names = ["drawing", "ocr", "asr", "translation", "messaging", "team-drive"];
  const manifests = await Promise.all(names.map(async (name) => JSON.parse(await readFile(new URL(`../../${name}-plugin/manifest.release-template.json`, import.meta.url), "utf8"))));
  const applications = manifests.map((manifest) => ({
    pluginKey: manifest.id, official: manifest.official,
    localization: manifest.localization, themes: manifest.themes,
  }));
  assert.equal(applications.length, 6);
  for (const app of applications) {
    assert.equal(app.official, true);
    assert.deepEqual(app.localization.supportedLocales, supportedLocaleCodes);
    assert.equal(app.localization.fallbackLocale, "zh-CN");
    assert.deepEqual(app.themes.supported, ["light", "dark"]);
    assert.equal(app.themes.usesSemanticTokens, true);
    assert.equal(app.themes.livePreferenceEvents, true);
  }
  const dispatched = [];
  const snapshots = publishOfficialCatalogPreferencesV1({
    applications,
    locale: "en", direction: "ltr", theme: "dark", semanticTokens: tokens, revision: 7,
    dispatch: (type, snapshot) => dispatched.push({ type, snapshot }),
  });
  assert.equal(snapshots.length, applications.length);
  assert.ok(snapshots.every(({ effective, disclosures }) => effective.locale === "en"
    && effective.theme === "dark" && disclosures.length === 0));
  assert.ok(snapshots.every(({ semanticTokens }) => semanticTokens.canvas === "value-canvas"));
  assert.ok(dispatched.every(({ type, snapshot }) => type === "teamaibox.plugin-preferences/v1" && snapshot.revision === 7));
  for (const name of names) {
    const [client, page, dockerfile] = await Promise.all([
      readFile(new URL(`../../${name}-plugin/src/public/app.js`, import.meta.url), "utf8"),
      readFile(new URL(`../../${name}-plugin/src/public/index.html`, import.meta.url), "utf8"),
      readFile(new URL(`../../${name}-plugin/Dockerfile`, import.meta.url), "utf8"),
    ]);
    assert.match(client, /subscribePluginPreferenceMessagesV1/);
    assert.match(client, /applyPluginPreferenceSnapshotV1/);
    assert.match(page, /platform-preferences\.css/);
    assert.match(dockerfile, /packages\/plugin-sdk/);
  }
});

test("third-party launch compatibility clearly discloses locale and theme fallbacks", () => {
  const compatibility = catalogPreferenceCompatibilityV1({
    app: {
      pluginKey: "third-party.reports",
      official: false,
      localization: { supportedLocales: ["en"], fallbackLocale: "en", supportedDirections: ["ltr"], rtlReady: false },
      themes: { supported: ["dark"], usesSemanticTokens: true, livePreferenceEvents: false },
    },
    locale: "zh-CN", direction: "ltr", theme: "light",
  });
  assert.deepEqual(compatibility.effective, { locale: "en", direction: "ltr", theme: "dark" });
  assert.deepEqual(compatibility.disclosures.map(({ code }) => code), [
    "locale-fallback", "theme-fallback", "live-updates-unavailable",
  ]);
});

test("web host reads the exact public semantic-token contract and has no generic placeholder dialog", async () => {
  const style = { getPropertyValue: (name) => tokens[name.slice(2)] ?? "" };
  assert.deepEqual(readActiveSemanticThemeTokensV1({ element: {}, getStyle: () => style }), tokens);
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /publishOfficialCatalogPreferencesV1/);
  assert.match(source, /DynamicApplicationWorkspace/);
  assert.doesNotMatch(source, /ApplicationDialog|app\.launch_body|app\.launch_title/);
  assert.doesNotMatch(source, /location\.reload/);
});

test("dynamic application host discloses compatibility, negotiates initial preferences, and keeps iframe state during live changes", async () => {
  const source = await readFile(new URL("../src/applications/DynamicApplicationWorkspace.tsx", import.meta.url), "utf8");
  assert.match(source, /catalogPreferenceCompatibilityV1/);
  assert.match(source, /compatibility\.effective\.locale/);
  assert.match(source, /compatibility\.effective\.theme/);
  assert.match(source, /app\.compatibility\.locale_fallback/);
  assert.match(source, /app\.compatibility\.theme_fallback/);
  assert.match(source, /plugin-workspace__compatibility/);
  assert.match(source, /initialSource = useRef<string \| null>\(null\)/);
  assert.match(source, /src=\{source\}/);
  assert.doesNotMatch(source, /key=\{(?:locale|theme)/);
});
