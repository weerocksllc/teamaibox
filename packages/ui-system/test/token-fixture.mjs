import { readFile } from 'node:fs/promises';

// Test-only reader: mirrors CSS inheritance for the two explicit token modes.
export async function readThemeTokens(theme) {
  const css = await readFile(new URL('../src/tokens.css', import.meta.url), 'utf8');
  const values = {};
  for (const block of css.matchAll(/(:root(?:\[data-theme="dark"\])?)\s*\{([^}]+)\}/g)) {
    if (block[1].includes('dark') && theme !== 'dark') continue;
    for (const [, key, value] of block[2].matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) values[key] = value.trim();
  }
  const resolve = (value, depth = 0) => depth > 8 ? value : value.replace(/var\(--([a-z0-9-]+)\)/g, (_, key) => resolve(values[key] ?? '', depth + 1));
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, resolve(value)]));
}
