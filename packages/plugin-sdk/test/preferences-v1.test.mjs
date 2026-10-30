import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPluginPreferenceSnapshotV1,
  createPluginPreferenceChannelV1,
  createPluginPreferenceSnapshotV1,
  postPluginPreferenceSnapshotV1,
  resolvePluginPreferenceCompatibilityV1,
  semanticThemeTokenNamesV1,
  subscribePluginPreferenceMessagesV1,
} from "../src/preferences-v1.mjs";

const tokens = (prefix) => Object.fromEntries(semanticThemeTokenNamesV1.map((name) => [name, `${prefix}-${name}`]));
const tokenSets = { light: tokens("light"), dark: tokens("dark") };

function manifest(overrides = {}) {
  return {
    id: "example.notes",
    official: false,
    localization: {
      supportedLocales: ["en"], fallbackLocale: "en",
      supportedDirections: ["ltr"], rtlReady: false,
    },
    themes: { supported: ["dark"], usesSemanticTokens: true, livePreferenceEvents: false },
    ...overrides,
  };
}

test("third-party compatibility discloses locale, direction, theme, and live-event fallbacks", () => {
  const result = resolvePluginPreferenceCompatibilityV1({
    manifest: manifest(), locale: "ar", direction: "rtl", theme: "light",
  });
  assert.deepEqual(result.effective, { locale: "en", direction: "ltr", theme: "dark" });
  assert.deepEqual(result.disclosures.map(({ code }) => code), [
    "locale-fallback", "theme-fallback", "live-updates-unavailable",
  ]);
  assert.equal(result.compatibility.localeSupported, false);
  assert.equal(result.compatibility.themeSupported, false);
});

test("official plugins must accept all current preferences and receive complete semantic tokens", () => {
  const official = manifest({
    id: "official.assistant", official: true,
    localization: {
      supportedLocales: ["zh-CN", "en"], fallbackLocale: "zh-CN",
      supportedDirections: ["ltr"], rtlReady: false,
    },
    themes: { supported: ["light", "dark"], usesSemanticTokens: true, livePreferenceEvents: true },
  });
  const snapshot = createPluginPreferenceSnapshotV1({
    manifest: official, locale: "en", direction: "ltr", theme: "dark", tokenSets, revision: 1,
  });
  assert.deepEqual(snapshot.disclosures, []);
  assert.equal(snapshot.effective.locale, "en");
  assert.equal(snapshot.semanticTokens.canvas, "dark-canvas");
  assert.equal(Object.keys(snapshot.semanticTokens).length, semanticThemeTokenNamesV1.length);

  const incompatible = structuredClone(official);
  incompatible.themes.supported = ["light"];
  assert.throws(() => resolvePluginPreferenceCompatibilityV1({
    manifest: incompatible, locale: "en", direction: "ltr", theme: "dark",
  }), /official plugin preference compatibility is incomplete/);
});

test("live channel emits the current snapshot, applies newer revisions, and rejects stale cross-plugin state", () => {
  const first = createPluginPreferenceSnapshotV1({
    manifest: manifest(), locale: "en", direction: "ltr", theme: "dark", tokenSets, revision: 1,
  });
  const second = createPluginPreferenceSnapshotV1({
    manifest: manifest(), locale: "zh-CN", direction: "ltr", theme: "light", tokenSets, revision: 2,
  });
  const channel = createPluginPreferenceChannelV1(first);
  const revisions = [];
  const unsubscribe = channel.subscribe((snapshot) => revisions.push(snapshot.revision));
  channel.publish(second);
  unsubscribe();
  assert.deepEqual(revisions, [1, 2]);
  assert.equal(channel.current().revision, 2);
  assert.throws(() => channel.publish(first), /stale/);
  const other = createPluginPreferenceSnapshotV1({
    manifest: manifest({ id: "example.other" }), locale: "en", direction: "ltr", theme: "dark", tokenSets, revision: 3,
  });
  assert.throws(() => channel.publish(other), /another plugin/);
});

test("plugin-side DOM helper applies language, direction, theme, revision, and every semantic token", () => {
  const snapshot = createPluginPreferenceSnapshotV1({
    manifest: manifest({
      themes: { supported: ["light", "dark"], usesSemanticTokens: true, livePreferenceEvents: true },
    }),
    locale: "zh-CN", direction: "ltr", theme: "light", tokenSets, revision: 8,
  });
  const attributes = new Map(), properties = new Map();
  const currentDocument = {
    documentElement: {
      setAttribute(name, value) { attributes.set(name, value); },
      style: { setProperty(name, value) { properties.set(name, value); } },
    },
  };
  const applied = applyPluginPreferenceSnapshotV1({ currentDocument, snapshot });
  assert.deepEqual(applied, snapshot);
  assert.deepEqual(Object.fromEntries(attributes), {
    lang: "en", dir: "ltr", "data-theme": "light", "data-plugin-preference-revision": "8",
  });
  assert.equal(properties.size, semanticThemeTokenNamesV1.length);
  assert.equal(properties.get("--teamaibox-canvas"), "light-canvas");
  assert.throws(() => applyPluginPreferenceSnapshotV1({ currentDocument, snapshot, cssVariablePrefix: "*" }), /CSS prefix/);
});

test("iframe transport uses an exact origin and ignores spoofed source or origin", () => {
  const snapshot = createPluginPreferenceSnapshotV1({
    manifest: manifest(), locale: "en", direction: "ltr", theme: "dark", tokenSets, revision: 1,
  });
  const posted = [];
  postPluginPreferenceSnapshotV1({
    targetWindow: { postMessage: (...args) => posted.push(args) },
    targetOrigin: "https://box.example.test",
    snapshot,
  });
  assert.deepEqual(posted, [[snapshot, "https://box.example.test"]]);
  assert.throws(() => postPluginPreferenceSnapshotV1({
    targetWindow: { postMessage() {} }, targetOrigin: "*", snapshot,
  }), /exact HTTP\(S\) origin/);

  let listener;
  const currentWindow = {
    addEventListener(type, value) { assert.equal(type, "message"); listener = value; },
    removeEventListener(type, value) { assert.equal(type, "message"); assert.equal(value, listener); },
  };
  const hostWindow = {};
  const received = [];
  const unsubscribe = subscribePluginPreferenceMessagesV1({
    currentWindow, hostWindow, hostOrigin: "https://box.example.test", onChange: (value) => received.push(value),
  });
  listener({ source: {}, origin: "https://box.example.test", data: snapshot });
  listener({ source: hostWindow, origin: "https://evil.example", data: snapshot });
  listener({ source: hostWindow, origin: "https://box.example.test", data: snapshot });
  unsubscribe();
  assert.deepEqual(received.map(({ revision }) => revision), [1]);
});
