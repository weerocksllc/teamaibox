import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { readThemeTokens } from "../../../packages/ui-system/test/token-fixture.mjs";

import {
  browserThemeStorage,
  persistThemePreference,
  recentThemeStorageKey,
  resolveInitialTheme,
  themeMetaColors,
} from "../src/preferences/theme-preference.mjs";

const requiredTokens = [
  "canvas", "surface", "surface-raised", "surface-subtle", "text", "text-muted",
  "border", "border-strong", "interactive", "interactive-hover", "on-interactive",
  "selected-surface", "selected-text", "focus", "disabled-surface", "disabled-text",
  "disabled-border", "success", "success-soft", "warning", "warning-soft", "error",
  "error-soft", "info", "info-soft", "chart-1", "chart-2", "chart-3", "chart-4",
  "chart-5", "chart-6", "code-surface", "code-text", "log-info", "log-warning",
  "log-error", "shadow-sm", "shadow-lg",
];

function storageFixture(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    value: (key) => values.get(key),
  };
}

function cssBlock(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `${selector} theme block exists`);
  return Object.fromEntries([...match[1].matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)]
    .map((entry) => [entry[1], entry[2].trim()]));
}

function luminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi).map((value) => Number.parseInt(value, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(left, right) {
  const a = luminance(left);
  const b = luminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function runPrepaint({ accountTheme, storedTheme, systemDark }) {
  const source = await readFile(new URL("../public/theme-prepaint.js", import.meta.url), "utf8");
  const documentElement = { dataset: {}, style: {} };
  const context = {
    __TEAM_AI_BOX_ACCOUNT_PREFERENCES__: accountTheme ? { preferredTheme: accountTheme } : undefined,
    localStorage: { getItem: () => storedTheme ?? null },
    matchMedia: () => ({ matches: systemDark }),
    document: { documentElement },
  };
  vm.runInNewContext(source, context);
  return documentElement;
}

test("pre-paint script applies account, device, then system theme before the application module", async () => {
  assert.equal((await runPrepaint({ accountTheme: "dark", storedTheme: "light", systemDark: false })).dataset.theme, "dark");
  assert.equal((await runPrepaint({ storedTheme: "light", systemDark: true })).dataset.theme, "light");
  const system = await runPrepaint({ storedTheme: "system", systemDark: true });
  assert.equal(system.dataset.theme, "dark");
  assert.equal(system.style.colorScheme, "dark");
  const index = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(index.indexOf("/theme-prepaint.js") < index.indexOf("/src/main.tsx"));
});

test("theme preference resolves and persists without making browser storage authoritative", async () => {
  const storage = storageFixture({ [recentThemeStorageKey]: "light" });
  assert.equal(resolveInitialTheme({ accountTheme: "dark", storage, systemDark: false }), "dark");
  assert.equal(resolveInitialTheme({ accountTheme: "system", storage, systemDark: true }), "dark");
  assert.equal(resolveInitialTheme({ storage, systemDark: true }), "light");
  assert.deepEqual(themeMetaColors, { light: "#f6f8f8", dark: "#10191e" });
  const updates = [];
  await persistThemePreference({
    theme: "dark",
    storage,
    accountTransport: { updatePreferredTheme: async (theme) => updates.push(theme) },
  });
  assert.equal(storage.value(recentThemeStorageKey), "dark");
  assert.deepEqual(updates, ["dark"]);
  assert.equal(browserThemeStorage(Object.defineProperty({}, "localStorage", {
    get() { throw new Error("opaque origin"); },
  })), undefined);
});

test("Light and Dark expose complete semantic tokens with readable text contrast", async () => {
  const source = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const themes = {
    light: await readThemeTokens('light'),
    dark: await readThemeTokens('dark'),
  };
  for (const [name, tokens] of Object.entries(themes)) {
    for (const token of requiredTokens) assert.ok(tokens[token], `${name} --${token}`);
    const pairs = [
      ["text", "canvas"], ["text-muted", "surface"], ["interactive", "surface"],
      ["warning", "surface"], ["error", "surface"], ["info", "surface"],
      ["code-text", "code-surface"],
    ];
    for (const [foreground, background] of pairs) {
      assert.ok(contrast(tokens[foreground], tokens[background]) >= 4.5,
        `${name} ${foreground}/${background} contrast`);
    }
  }
  assert.match(source, /\.chart-series-6 \{ color: var\(--chart-6\); \}/);
  assert.match(source, /\.code-editor, \.log-viewer/);
  assert.match(source, /\.owner-recovery__operator code \{[^}]*background: var\(--code-surface\);[^}]*color: var\(--code-text\);/);
  assert.match(source, /button:focus-visible[\s\S]*?\[tabindex\]:focus-visible/);
});

test("runtime theme switching preserves state and statuses include text or icons", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const authenticatedSource = await readFile(new URL("../src/auth/AuthenticatedApp.tsx", import.meta.url), "utf8");
  assert.match(source, /setThemePreference\(nextTheme\)/);
  assert.match(source, /media\.addEventListener\("change", onChange\)/);
  assert.match(source, /document\.documentElement\.dataset\.theme = theme/);
  assert.match(source, /document\.documentElement\.style\.colorScheme = theme/);
  assert.match(authenticatedSource, /document\.documentElement\.style\.colorScheme = theme/);
  assert.doesNotMatch(source, /location\.reload/);
  assert.match(source, /task-state[\s\S]*?t\(`task\.\$\{task\.state\}`\)/);
  assert.match(source, /status-dot[\s\S]*?services\.summary/);
  assert.match(source, /access-tag[\s\S]*?t\(canManage \? "admin\.manage" : "admin\.read_only"\)/);
});

test('workbench assistant uses a light surface in light mode with readable controls', async () => {
  const light=await readThemeTokens('light'),dark=await readThemeTokens('dark');
  assert.ok(luminance(light['hero-surface'])>.7,'light mode must not contain a dark assistant panel');
  for(const colors of [light,dark]){
    assert.ok(contrast(colors['hero-text'],colors['hero-surface'])>=4.5);
    assert.ok(contrast(colors['hero-on-interactive'],colors['hero-interactive'])>=4.5);
  }
  const phones=await readFile(new URL('../src/phones/PhoneAdministrationPanel.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(phones,/Cuttlefish|ARM64|KVM/);
});
