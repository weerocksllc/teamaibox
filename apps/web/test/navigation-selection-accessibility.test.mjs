import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = (path) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");

test("workbench and administrator navigation expose the current destination", async () => {
  const app = await source("App.tsx");
  assert.match(app, /aria-current=\{surface === "workbench" \? "page" : undefined\}/);
  assert.match(app, /aria-current=\{activeApp\?\.pluginKey === app\.pluginKey \? "page" : undefined\}/);
  assert.match(app, /const active = surface === "admin" && activeAdminItem === item\.id;/);
  assert.match(app, /aria-current=\{active \? "page" : undefined\}/);
  assert.doesNotMatch(app, /t\("nav\.admin"\)/);
  assert.doesNotMatch(app, /admin-domain-card/);
});

test("mobile overlay launchers expose their expanded state", async () => {
  const app = await source("App.tsx");
  for (const state of ["mobileMenuOpen", "taskOpen", "profileOpen"]) {
    assert.match(app, new RegExp(`aria-expanded=\\{${state}\\}`));
  }
});

test("detail navigation and ecosystem selectors expose selection semantics", async () => {
  const [assistant, nodes, teams, sources, models, catalog] = await Promise.all([
    source("assistant/AssistantWorkspace.tsx"),
    source("device/AppliancePanel.tsx"),
    source("teams/TeamAdministrationPanel.tsx"),
    source("sources/SourceCenterPanel.tsx"),
    source("models/ModelAdministrationPanel.tsx"),
    source("i18n.ts"),
  ]);
  assert.match(assistant, /aria-current=\{item\.id === activeId \? "page" : undefined\}/);
  assert.match(assistant, /className="assistant-mode-selector" role="group"/);
  assert.match(assistant, /aria-pressed=\{mode === item\}/);
  assert.doesNotMatch(nodes, /setSelectedNode|targetNodeIds/);
  assert.match(teams, /aria-current=\{selected\?\.id === team\.id \? "page" : undefined\}/);
  assert.match(sources, /className="source-center-summary" role="group" aria-label=\{t\("admin\.sources\.ecosystems"\)\}/);
  assert.match(sources, /aria-pressed=\{item === ecosystem\}/);
  assert.match(models, /aria-pressed=\{profile\.profileKey === selectedKey\}/);
  assert.equal((catalog.match(/"admin\.sources\.ecosystems":/g) ?? []).length, 2);
});

test("sign-in dropdowns and profile preferences expose native selection without inert settings links", async () => {
  const [auth, preferences, app, catalog] = await Promise.all([source("auth/AuthenticatedApp.tsx"), source("preferences/AppearancePreferences.tsx"), source("App.tsx"), source("i18n.ts")]);
  assert.match(auth, /<AppearancePreferences locale=\{locale\} theme=\{themePreference\}/);
  assert.doesNotMatch(auth, /auth-segmented/);
  assert.equal((preferences.match(/<label className="appearance-select"/g) ?? []).length, 2);
  assert.match(preferences, /<select aria-label=\{languageLabel\} value=\{locale\}/);
  assert.match(preferences, /<select aria-label=\{themeLabel\} value=\{theme\}/);
  for (const value of ["zh-CN", "en", "light", "dark", "system"]) assert.ok(preferences.includes(`value="${value}"`));
  assert.match(auth, /themePreference === "system" \? \(systemDark \? "dark" : "light"\) : themePreference/);
  assert.match(app, /<AppearancePreferences variant="profile" locale=\{locale\} theme=\{theme\}/);
  assert.match(app, /theme=\{themePreference\}[\s\S]*?setTheme=\{changeTheme\}/);
  assert.doesNotMatch(app, /className="segmented"/);
  assert.doesNotMatch(app, /className="profile-setting"/);
  assert.equal((catalog.match(/"auth\.(?:language|theme)":/g) ?? []).length, 4);
});
