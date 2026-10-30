import assert from "node:assert/strict";
import { test } from "node:test";

import {
  browserLocaleStorage,
  persistLocalePreference,
  recentLocaleStorageKey,
  resolveInitialLocale,
} from "../src/preferences/locale-preference.mjs";

function storageFixture(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    value: (key) => values.get(key),
  };
}

test("only manual choices override English, including a manual choice of Chinese", () => {
  const storage = storageFixture({ [recentLocaleStorageKey]: "zh-CN" });
  assert.equal(resolveInitialLocale({ accountLocale: "en", accountLocaleExplicit: true, storage, browserLocales: ["en-US"] }), "zh-CN");
  assert.equal(resolveInitialLocale({ accountLocale: "zh-CN", storage: storageFixture(), browserLocales: ["ja-JP"] }), "en");
  assert.equal(resolveInitialLocale({ accountLocale: "en", accountLocaleExplicit: false, browserLocales: ["ja-JP"] }), "en");
  assert.equal(resolveInitialLocale({ accountLocale: "zh-CN", accountLocaleExplicit: true, browserLocales: ["en-US"] }), "zh-CN");
  assert.equal(resolveInitialLocale({ storage, browserLocales: ["en-US"] }), "zh-CN");
  assert.equal(resolveInitialLocale({ storage: storageFixture(), browserLocales: ["fr-FR", "en-US"] }), "en");
  assert.equal(resolveInitialLocale({ storage: storageFixture(), browserLocales: ["fr-FR"] }), "en");
  assert.equal(browserLocaleStorage(Object.defineProperty({}, "localStorage", {
    get() { throw new Error("opaque origin"); },
  })), undefined);
});

test("all browser languages and unavailable or invalid preferences default to English", () => {
  for (const browser of ['en-GB','ja-JP','zh-HK','zh-Hans','pt-PT','ar-SA']) {
    assert.equal(resolveInitialLocale({storage:storageFixture(),browserLocales:['zz-ZZ',browser,'en-US']}),'en');
  }
  assert.equal(resolveInitialLocale({storage:{getItem(){throw Error('blocked');}},browserLocales:['de-DE']}),'en');
  assert.equal(resolveInitialLocale({storage:storageFixture({[recentLocaleStorageKey]:'invalid'}),accountLocale:'invalid',accountLocaleExplicit:true}),'en');
  assert.equal(resolveInitialLocale({storage:storageFixture()}),'en');
});

test("English default is not persisted; manual choice survives browser changes and refresh", async () => {
  const storage=storageFixture();
  assert.equal(resolveInitialLocale({storage,browserLocales:['en-US']}),'en');
  assert.equal(storage.value(recentLocaleStorageKey),undefined);
  assert.equal(resolveInitialLocale({storage,browserLocales:['ja-JP']}),'en');
  await persistLocalePreference({locale:'fr',storage});
  assert.equal(resolveInitialLocale({storage,browserLocales:['ja-JP']}),'fr');
});

test("runtime locale switch persists a non-sensitive device hint and authenticated account preference", async () => {
  const storage = storageFixture();
  const updates = [];
  assert.equal(await persistLocalePreference({
    locale: "en",
    storage,
    accountTransport: { updatePreferredLocale: async (locale) => updates.push(locale) },
  }), "en");
  assert.equal(storage.value(recentLocaleStorageKey), "en");
  assert.deepEqual(updates, ["en"]);
  await assert.rejects(persistLocalePreference({ locale: "zz-ZZ", storage }), /unsupported locale/);
});
