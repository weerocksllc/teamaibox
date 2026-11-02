import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('narrow toolbar hiding never hides the profile preference controls', async () => {
  const css = await read('../src/focus-workspace.css');
  assert.match(css, /\.topbar \.appearance-preferences--toolbar \{ display: none; \}/);
  assert.doesNotMatch(css, /\.topbar \.appearance-preferences\s*\{[^}]*display:\s*none/);
  assert.match(css, /\.appearance-preferences--toolbar \.appearance-select/);
  const app = await read('../src/App.tsx');
  assert.match(app, /<AppearancePreferences variant="profile" locale=\{locale\} theme=\{theme\} onLocaleChange=\{setLocale\} onThemeChange=\{setTheme\}/);
});

test('global panels keep their content within the available viewport', async () => {
  const css = await read('../src/focus-workspace.css');
  assert.match(css, /\.search-dialog \{[^}]*display: flex;[^}]*max-height: 100%/);
  assert.match(css, /\.search-dialog__input \{ flex: 0 0 auto/);
  assert.match(css, /\.search-dialog__body \{ min-height: 0/);
  assert.match(css, /\.topbar \.popover \{[^}]*max-height: calc\(100dvh[^}]*overflow: auto/);
});
