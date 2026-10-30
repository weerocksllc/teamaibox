import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { test } from "node:test";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));

async function files(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile() && path.endsWith(".tsx")) result.push(path);
  }
  return result;
}

test("every React button is a form action or has an explicit behavior", async () => {
  const inert = [];
  for (const path of await files(sourceRoot)) {
    const source = await readFile(path, "utf8");
    const scan = source.replaceAll("=>", "ARROW");
    for (const match of scan.matchAll(/<button\b[^>]*>/g)) {
      const markup = match[0];
      const type = markup.match(/\stype="([^"]+)"/)?.[1] ?? "submit";
      const wired = new Set(["submit", "reset"]).has(type) || /\sonClick=/.test(markup) || /\sformAction=/.test(markup);
      if (!wired) {
        const line = scan.slice(0, match.index).split("\n").length;
        inert.push(`${relative(sourceRoot, path)}:${line}`);
      }
    }
  }
  assert.deepEqual(inert, []);
});
