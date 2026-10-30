import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { withLoginAppearance, persistLoginAppearance } from "../src/preferences/login-appearance.mjs";

const session = Object.freeze({ authenticated: true, identity: Object.freeze({ id: "fixture", roles: ["member"] }),
  permissions: ["application:catalog:view"], preferences: Object.freeze({ preferredLocale: "zh-CN", preferredTheme: "light" }) });

test("interactive sign-in retains visible dark appearance over saved light without changing identity or permissions", () => {
  const next = withLoginAppearance(session, { locale: "en", localeExplicit: true, theme: "dark" });
  assert.deepEqual(next.preferences, { preferredLocale: "en", preferredLocaleExplicit: true, preferredTheme: "dark" });
  assert.equal(next.identity, session.identity);
  assert.equal(next.permissions, session.permissions);
  assert.equal(session.preferences.preferredTheme, "light");
});

test("English default never overwrites or freezes an explicit account preference on sign-in", async () => {
  const account={...session,preferences:{...session.preferences,preferredLocale:'fr',preferredLocaleExplicit:true}};
  const appearance={locale:'en',localeExplicit:false,theme:'light'};
  assert.equal(withLoginAppearance(account,appearance).preferences.preferredLocale,'fr');
  const writes=[];
  await persistLoginAppearance(account.preferences,appearance,{updatePreferredLocale:async value=>writes.push(value)});
  assert.deepEqual(writes,[]);
  await persistLoginAppearance(session.preferences,{locale:'zh-CN',localeExplicit:true,theme:'light'},
    {updatePreferredLocale:async value=>writes.push(value)});
  assert.deepEqual(writes,['zh-CN'],'selecting Chinese still records manual intent');
});

test("automatic session restoration leaves account preferences unchanged", () => {
  assert.equal(withLoginAppearance(session), session);
});

test("only changed preferences are persisted and system remains a preference rather than a resolved color", async () => {
  const writes = [];
  const transport = { updatePreferredLocale: async value => writes.push(["locale", value]), updatePreferredTheme: async value => writes.push(["theme", value]) };
  await persistLoginAppearance(session.preferences, { locale: "zh-CN", theme: "system" }, transport);
  assert.deepEqual(writes, [["theme", "system"]]);
  writes.length = 0;
  await persistLoginAppearance(session.preferences, { locale: "zh-CN", theme: "light" }, transport);
  assert.deepEqual(writes, []);
});

test("save failures are reported while the already-applied appearance remains intact", async () => {
  const appearance = { locale: "zh-CN", theme: "dark" };
  const next = withLoginAppearance(session, appearance);
  await assert.rejects(persistLoginAppearance(session.preferences, appearance, { updatePreferredTheme: async () => { throw new Error("unavailable"); } }), /unavailable/);
  assert.equal(next.preferences.preferredTheme, "dark");
});

test("only the interactive sign-in passes appearance; the workspace and login share selectors", async () => {
  const auth = await readFile(new URL("../src/auth/AuthenticatedApp.tsx", import.meta.url), "utf8");
  assert.match(auth, /install\(session, \{ locale, localeExplicit: localeChosen.current \|\| storedLocalePreference\(\) !== null, theme: themePreference \}\)/);
  assert.equal((auth.match(/install\(session, /g) || []).length, 1);
  assert.match(auth, /if \(session\) install\(session\);/);
  assert.match(auth, /Powered By DGX Spark/);
});
