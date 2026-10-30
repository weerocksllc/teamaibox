import assert from "node:assert/strict";
import test from "node:test";

import { matchesUserActivityHttpRoute, UserActivityHttpApi } from "../src/tasks/user-activity-http-api.mjs";

const TASK = "018f6f18-24d7-7c21-9b62-8c0174199591";

test("user activity routes expose overview, own cancellation, and refreshed result redirects only", async () => {
  const calls = [];
  const api = new UserActivityHttpApi({ service: {
    async overview(input) { calls.push(["overview", input]); return { tasks: [] }; },
    async cancelOwn(input) { calls.push(["cancel", input]); return { taskId: input.taskId }; },
    async resultOwn(input) { calls.push(["result", input]); return { taskId: input.taskId, referenceId: TASK }; },
  } });
  assert.equal(matchesUserActivityHttpRoute("GET", "/api/v1/user/activity"), true);
  assert.equal(matchesUserActivityHttpRoute("POST", `/api/v1/user/tasks/${TASK}/cancel`), true);
  assert.equal(matchesUserActivityHttpRoute("GET", `/api/v1/user/tasks/${TASK}/result`), true);
  assert.equal(matchesUserActivityHttpRoute("GET", "/api/v1/admin/operations/dashboard"), false);
  const context = { identityId: TASK };
  assert.equal((await api.handle({ method: "GET", pathname: "/api/v1/user/activity", context })).status, 200);
  assert.equal((await api.handle({ method: "POST", pathname: `/api/v1/user/tasks/${TASK}/cancel`, context })).status, 202);
  assert.deepEqual(calls[1], ["cancel", { context, taskId: TASK }]);
  const result = await api.handle({ method: "GET", pathname: `/api/v1/user/tasks/${TASK}/result`, context });
  assert.equal(result.status, 302);
  assert.equal(result.headers.location, `/api/v1/objects/references/${TASK}/content?download=1`);
  assert.deepEqual(calls[2], ["result", { context, taskId: TASK }]);
});
