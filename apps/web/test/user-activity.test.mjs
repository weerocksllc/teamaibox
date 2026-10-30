import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const client = await readFile(new URL("../src/activity/user-activity-client.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("workbench loads user-scoped availability and tasks instead of static workload examples", () => {
  assert.match(app, /loadUserActivity\(\{ signal \}\)/);
  assert.match(app, /return startSerialRefresh\(/);
  assert.match(client, /signal, credentials: "same-origin"/);
  assert.match(app, /activity\?\.tasks/);
  assert.doesNotMatch(app, /const tasks = \[/);
  assert.match(client, /fetch\("\/api\/v1\/user\/activity"/);
  assert.doesNotMatch(client, /admin\/operations|nodeId|workerId|ownerIdentityId|prompt|filename/);
});

test("own-task cancellation uses same-origin CSRF and the user task endpoint", () => {
  assert.match(client, /__Host-teamaibox-csrf=/);
  assert.match(client, /\/api\/v1\/user\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/cancel/);
  assert.match(client, /credentials: "same-origin"/);
  assert.match(client, /"x-csrf-token": csrfToken\(\)/);
});

test("completed tasks expose an authenticated result download link", () => {
  assert.match(app, /task\.results\.length > 0/);
  assert.match(app, /\/api\/v1\/user\/tasks\/\$\{encodeURIComponent\(result\.artifactRef\)\}\/result/);
  assert.match(app, /tasks\.result\.download/);
  assert.match(styles, /\.task-result-links a/);
});

test("service availability and task states retain non-color labels and responsive layouts", () => {
  assert.match(app, /services\.state\.\$\{item\.state\}/);
  assert.match(app, /task\.\$\{task\.state\}/);
  assert.match(styles, /\.service-grid \{[^}]*grid-template-columns: repeat\(6/);
  assert.match(styles, /@media \(max-width: 600px\)[\s\S]*?\.service-grid \{ grid-template-columns: repeat\(2/);
});
