import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  catalogs,
  createI18nRuntime,
  fallbackLocale,
  namespacedCatalogs,
  supportedLocales,
} from "../src/i18n.ts";

test("all 17 product catalogs are complete and grouped by namespace", () => {
  assert.equal(supportedLocales.length, 17);
  assert.equal(fallbackLocale, "en");
  assert.deepEqual(Object.keys(catalogs.en).sort(), Object.keys(catalogs["zh-CN"]).sort());
  for (const locale of supportedLocales) {
    assert.deepEqual(Object.keys(catalogs[locale]).sort(), Object.keys(catalogs.en).sort());
    assert.equal(Object.hasOwn(catalogs[locale], "unknown.key"), false);
    for (const [namespace, messages] of Object.entries(namespacedCatalogs[locale])) {
      assert.ok(Object.keys(messages).length > 0, `${locale}/${namespace} is populated`);
      for (const [key, value] of Object.entries(messages)) {
        assert.equal(catalogs[locale][`${namespace}.${key}`], value);
      }
    }
  }
});

test("runtime uses documented fallback and deduplicated missing-key diagnostics", () => {
  const diagnostics = [];
  const runtime = createI18nRuntime({
    locale: "ja",
    catalogSet: {
      ja: { "known.english": "English" },
      en: { "known.english": "English", "fallback.only": "Fallback text" },
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  assert.equal(runtime.translate("known.english"), "English");
  assert.equal(runtime.translate("fallback.only"), "Fallback text");
  assert.equal(runtime.translate("missing.key"), "missing.key");
  assert.equal(runtime.translate("missing.key"), "missing.key");
  assert.deepEqual(diagnostics.map(({ kind, key }) => ({ kind, key })), [
    { kind: "fallback", key: "fallback.only" },
    { kind: "missing", key: "missing.key" },
  ]);
});

test("missing or unsupported runtime locale defaults to English", () => {
  for (const locale of [undefined, null, '', 'zz-ZZ']) {
    const runtime = createI18nRuntime({locale});
    assert.equal(runtime.locale, 'en');
    assert.equal(runtime.translate('nav.home'), 'Workbench');
  }
});

test("durable compute task labels and failure guidance are localized in both languages", () => {
  for (const locale of supportedLocales) {
    const diagnostics = [];
    const runtime = createI18nRuntime({ locale, onDiagnostic: (value) => diagnostics.push(value) });
    for (const key of ["tasks.kind.image-generation", "tasks.kind.embedding", "tasks.compute.waiting",
      "tasks.compute.failed", "tasks.compute.retry_later", "tasks.compute.deadline_exceeded"]) {
      assert.notEqual(runtime.translate(key), key);
      assert.ok(runtime.translate(key).trim());
    }
    assert.deepEqual(diagnostics, []);
  }
});

test("locale switch changes messages and Intl date, list, relative, unit, and plural formatting", () => {
  const chinese = createI18nRuntime({ locale: "zh-CN" });
  const english = createI18nRuntime({ locale: "en" });
  assert.equal(chinese.translate("nav.home"), "工作台");
  assert.equal(english.translate("nav.home"), "Workbench");
  const date = new Date("2026-08-10T00:00:00.000Z");
  assert.notEqual(
    chinese.formatDateTime(date, { dateStyle: "long", timeZone: "UTC" }),
    english.formatDateTime(date, { dateStyle: "long", timeZone: "UTC" }),
  );
  assert.notEqual(chinese.formatList(["A", "B", "C"]), english.formatList(["A", "B", "C"]));
  assert.notEqual(
    chinese.formatRelativeTime(-1, "day", { numeric: "auto" }),
    english.formatRelativeTime(-1, "day", { numeric: "auto" }),
  );
  assert.ok(english.formatUnit(128, "gigabyte").includes("128"));
  assert.equal(english.selectPlural(1, { one: "{count} task", other: "{count} tasks" }), "1 task");
  assert.equal(english.selectPlural(2, { one: "{count} task", other: "{count} tasks" }), "2 tasks");
  assert.equal(chinese.direction, "ltr");
  assert.equal(english.direction, "ltr");
});

test("application updates document language and direction without a reload path", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /document\.documentElement\.lang = i18n\.locale/);
  assert.match(source, /document\.documentElement\.dir = i18n\.direction/);
  assert.match(source, /setLocale\(nextLocale\)/);
  assert.doesNotMatch(source, /location\.reload/);
});
