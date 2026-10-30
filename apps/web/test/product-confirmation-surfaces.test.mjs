import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = (relative) => readFile(new URL(relative, import.meta.url), "utf8");

test("destructive product actions use themed accessible confirmation surfaces", async () => {
  const [providers, driveHtml, driveScript] = await Promise.all([
    source("../src/providers/ExternalProvidersPanel.tsx"),
    source("../../team-drive-plugin/src/public/index.html"),
    source("../../team-drive-plugin/src/public/app.js"),
  ]);

  assert.doesNotMatch(providers, /window\.confirm\s*\(/);
  assert.match(providers, /role="alertdialog"/);
  assert.match(providers, /aria-expanded=\{confirmingRemoval\}/);

  assert.doesNotMatch(driveScript, /\bconfirm\s*\(/);
  assert.match(driveHtml, /id="trash-dialog"[^>]+aria-labelledby="trash-dialog-title"[^>]+aria-describedby="trash-dialog-description"/);
  assert.match(driveScript, /openTrashConfirmation/);
  assert.match(driveScript, /ariaBusy="true"/);

});
