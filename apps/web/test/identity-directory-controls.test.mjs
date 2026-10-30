import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
test("role and team account selectors request bounded pages with literal server search", () => {
  for (const [directory, name] of [["roles", "role"], ["teams", "team"]]) {
    const client = read(`${directory}/${name}-administration-client.ts`);
    assert.match(client, /limit: "50", offset: String\(offset\), q: query/);
    const panel = read(`${directory}/${name === "role" ? "Role" : "Team"}AdministrationPanel.tsx`);
    assert.match(panel, /<DirectoryControls/);
    assert.match(panel, /current !== request.current/);
    assert.match(panel, /focusInlineConfirmation/);
  }
});
test("shared directory controls have real bilingual labels and no hidden total cap", () => {
  const controls = read("users/DirectoryControls.tsx"), i18n = read("i18n.ts");
  for (const [, key] of controls.matchAll(/t\("([^"]+)"/g)) {
    assert.equal(i18n.split(`"${key}":`).length - 1, 2, key);
  }
  assert.match(controls, /onLoad\(0, draft.trim\(\)\)/);
  assert.match(controls, /page.offset \+ page.limit, query/);
  assert.match(controls, /page\?\.total === 0/);
});
