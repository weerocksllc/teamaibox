import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

test("localized service status cannot expand the workbench viewport", () => {
  assert.match(styles, /\.availability-pill \{[^}]*min-width: 0;[^}]*overflow: hidden;/);
  assert.match(styles, /\.availability-pill > span:last-child \{[^}]*min-width: 0;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;/);
});

test("mobile workbench removes the desktop status pill and sidebar offset", () => {
  const mobile = styles.match(/@media \(max-width: 820px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(mobile, /\.workspace \{ margin-left: 0;/);
  assert.match(mobile, /\.availability-pill \{ display: none;/);
});

test("mobile profile and application drawer close each other", () => {
  assert.match(app, /const openMobileMenu = \(\) => \{\s*setProfileOpen\(false\);\s*setNotificationsOpen\(false\);\s*setMobileMenuOpen\(true\);/);
  assert.match(app, /const toggleMobileProfile = \(\) => \{\s*setMobileMenuOpen\(false\);\s*setNotificationsOpen\(false\);\s*setProfileOpen\(\(open\) => !open\);/);
  assert.match(app, /className="mobile-nav__item" aria-expanded=\{mobileMenuOpen\} onClick=\{openMobileMenu\}/);
  assert.match(app, /className="mobile-nav__item" aria-expanded=\{profileOpen\} onClick=\{toggleMobileProfile\}/);
});

test("service availability cards collapse without widening a mobile workbench", () => {
  assert.match(styles, /\.service-chip \{[^}]*min-width: 0;/);
  assert.match(styles, /@media \(max-width: 600px\)[\s\S]*?\.service-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
});
