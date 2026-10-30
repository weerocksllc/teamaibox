import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const plugins = ["drawing", "ocr", "asr", "translation", "messaging", "team-drive"];
const passiveDataAttributes = new Set(["i18n", "i18n-aria", "i18n-placeholder"]);

function attribute(markup, name) {
  return markup.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;
}

function camel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function hasHandler(markup, script) {
  const type = attribute(markup, "type") ?? "submit";
  if (new Set(["submit", "reset"]).has(type)) return true;
  const id = attribute(markup, "id");
  if (id && (script.includes(`"#${id}"`) || script.includes(`'#${id}'`))) return true;
  const dataAttributes = [...markup.matchAll(/\sdata-([a-z0-9-]+)(?:="[^"]*")?/g)]
    .map((match) => match[1])
    .filter((name) => !passiveDataAttributes.has(name));
  return dataAttributes.some((name) => script.includes(`[data-${name}]`) || script.includes(`dataset.${camel(name)}`));
}

test("every static official-application button is connected to behavior", async () => {
  for (const plugin of plugins) {
    const root = new URL(`../../${plugin}-plugin/src/public/`, import.meta.url);
    const [html, script] = await Promise.all([readFile(new URL("index.html", root), "utf8"), readFile(new URL("app.js", root), "utf8")]);
    const inert = [...html.matchAll(/<button\b[^>]*>/g)]
      .map((match) => match[0])
      .filter((markup) => !markup.includes(" disabled"))
      .filter((markup) => !hasHandler(markup, script));
    assert.deepEqual(inert, [], `${plugin} contains enabled button markup without a behavior binding`);
  }
});
