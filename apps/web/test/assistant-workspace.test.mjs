import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workspace = await readFile(new URL("../src/assistant/AssistantWorkspace.tsx", import.meta.url), "utf8");
const client = await readFile(new URL("../src/assistant/assistant-client.ts", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("AI Assistant is one application for answer-only, automatic, and Agent-capable work", () => {
  assert.match(app, /activeApp\?\.pluginKey === "official\.assistant"/);
  assert.match(app, /<AssistantWorkspace/);
  assert.match(workspace, /\["auto", "answer", "agent"\]/);
  assert.match(workspace, /message\.effectiveMode/);
  assert.match(workspace, /message\.routing\.targetKind/);
  assert.match(workspace, /message\.routing\.modelKey/);
});

test("Assistant client uses authenticated CSRF mutations, idempotent messages, and resumable event cursors", () => {
  assert.match(client, /__Host-teamaibox-csrf=/);
  assert.match(client, /"idempotency-key": `browser-\$\{crypto\.randomUUID\(\)\}`/);
  assert.match(client, /events\?after=\$\{afterSequence\}/);
  assert.match(client, /if \(value\.sequence <= cursor\) return/);
  for (const event of ["response.delta", "tool.started", "artifact.created", "source.cited", "confirmation.requested"]) {
    assert.ok(client.includes(`"${event}"`), event);
  }
});

test("Assistant workspace renders visible tool, source, artifact, usage, cancellation, and exact confirmation surfaces", () => {
  assert.match(workspace, /assistant-tools/);
  assert.match(workspace, /message\.sources/);
  assert.match(workspace, /message\.artifacts/);
  assert.match(workspace, /message\.usage/);
  assert.match(workspace, /cancelAssistantRun/);
  assert.match(workspace, /formatScope\(confirmation\.scope\)/);
  assert.match(workspace, /decideAssistantConfirmation/);
  assert.match(workspace, /item\.status === "pending"/);
  assert.match(workspace, /uploadAssistantInput/);
  assert.match(workspace, /message\.error\.retryable/);
  assert.match(client, /capability=assistant\.input/);
});

test("Assistant workspace has semantic Light/Dark tokens and mobile-browser layout", () => {
  assert.match(styles, /\.assistant-workspace \{[\s\S]*?background: var\(--canvas\)/);
  assert.doesNotMatch(styles, /\.assistant-workspace[^}]*#[0-9a-f]{3,8}/i);
  assert.match(styles, /@media \(max-width: 820px\)[\s\S]*?\.assistant-workspace__body \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(styles, /@media \(max-width: 600px\)[\s\S]*?\.assistant-mode-selector \{ width: 100%/);
});

test("Assistant file attachment control exposes its own accessible name", () => {
  const fileControl = workspace.match(/<input\s+type="file"[\s\S]*?(?=onChange=)/)?.[0];
  assert.ok(fileControl, "file attachment input exists");
  assert.match(fileControl, /aria-label=\{t\("assistant\.workspace\.attach"\)\}/);
  assert.match(fileControl, /\bmultiple\b/);
});

test("operation confirmation translates known actions and has a human-readable fallback", () => {
  assert.doesNotMatch(workspace, /<p>\{confirmation\.titleKey\}<\/p>/);
  assert.match(workspace, /t\(confirmation\.titleKey\) === confirmation\.titleKey \? t\("assistant\.workspace\.confirm_operation"\)/);
});
