import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('management dialogs keep native modality and caller-owned cancellation', async () => {
  const ui = await read('../src/EditorDialog.tsx');
  assert.match(ui, /node\.showModal\(\)/);
  assert.match(ui, /node\.close\(\); if \(opener\?\.isConnected\) opener\.focus\(\)/);
  assert.match(ui, /if \(!busy\) onCancel\(\)/);
  assert.match(ui, /aria-busy=\{busy\}/);
  assert.match(ui, /<Button[^>]+aria-label=\{closeLabel\} disabled=\{busy\} onClick=\{onCancel\}/);
  assert.match(ui, /const firstField = body\?\.querySelector/);
  assert.match(ui, /\(firstField \?\? body\?\.querySelector/);
  assert.match(ui, /className="precision-editor__body"/);
  assert.doesNotMatch(ui, /fetch\(|FormData|requestSubmit|\.submit\(/);
});

test('task presentation retains existing state, cancellation and result contracts', async () => {
  const ui = await read('../src/App.tsx');
  assert.match(ui, /data-task-state=\{task\.state\}/);
  assert.match(ui, /className="task-detail">\{taskDetail\(task, t\)\}/);
  assert.match(ui, /role="progressbar"[^>]+aria-valuenow=\{task\.progress\}/);
  assert.match(ui, /task\.results\.map/);
  assert.match(ui, /encodeURIComponent\(result\.artifactRef\)/);
  assert.match(ui, /task\.canCancel && onCancel/);
  assert.match(ui, /disabled=\{cancelling\} onClick=\{\(\) => onCancel\(task\.taskId\)\}/);
  assert.match(ui, /className="drawer-content"><div className="task-list"/);
  assert.match(ui, /state === "error" \? <ActivityState[^>]+state="error"/);
  assert.match(ui, /tasks\.length === 0 \? <ActivityState[^>]+state="empty"/);
});

test('long forms and task lists scroll below their persistent headings', async () => {
  const css = await read('../src/focus-workspace.css');
  assert.match(css, /\.precision-editor\[open\][^}]+overflow: hidden/);
  assert.match(css, /\.precision-editor__body[^}]+min-height: 0[^}]+overflow: auto/);
  assert.match(css, /\.drawer-heading[^}]+flex: 0 0 auto/);
  assert.match(css, /\.drawer-content[^}]+min-height: 0[^}]+overflow: auto/);
  assert.match(css, /\.task-row \.task-summary[^}]+white-space: normal/);
  assert.match(css, /\.task-row\[data-task-state=failed\][^}]+var\(--danger\)/);
  assert.match(css, /\.identity-admin > \.identity-admin__state:is\(\[role=alert\],\[aria-busy=true\]\) \{ order: -1/);
  assert.match(css, /\.operations-metrics-grid[^}]+repeat\(auto-fit,minmax\(min\(100%,220px\),1fr\)\)/);
  assert.match(css, /\.operations-alerts article :is\(strong,small\)[^}]+white-space: normal/);
  assert.doesNotMatch(css, /https?:\/\/|@import|url\(/);
});

test('member creation retains the existing fields and groups only its actions', async () => {
  const ui = await read('../src/users/UserAdministrationPanel.tsx');
  for (const name of ['loginName', 'displayName', 'password']) assert.ok(ui.includes(`name="${name}"`));
  assert.match(ui, /name="password"[^>]+minLength=\{15\}/);
  assert.match(ui, /<footer className="precision-editor__actions">/);
  assert.match(ui, /onSubmit\(\{ loginName: String\(form\.get\("loginName"\)\)/);
  assert.match(ui, /<button type="submit" className="primary-button" disabled=\{busy\}/);
});

test('extra task-state fixtures are opt-in and isolated from product code', async () => {
  const preview = await read('../tools/operations-preview-server.mjs');
  assert.match(preview, /process\.env\.TEAMAIBOX_PREVIEW_TASK_VARIANTS === "1"/);
  assert.match(preview, /\["failed", "cancelled", "queued"\]/);
  assert.match(preview, /server\.listen\(port, "127\.0\.0\.1"/);
  const ui = await read('../src/App.tsx');
  assert.doesNotMatch(ui, /TEAMAIBOX_PREVIEW_TASK_VARIANTS|synthetic_failure/);
});
