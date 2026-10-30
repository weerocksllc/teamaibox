import assert from "node:assert/strict";
import { test } from "node:test";

import { createCoreServiceObjectives } from "../../../deploy/compose/core-service-objective.mjs";

test("core survival objectives execute real identity, administration, files, messaging, object, and scheduler operations", async () => {
  const expected = {
    "platform-api": ["identity"],
    web: ["administration"],
    "object-service": ["files", "object"],
    messaging: ["messaging"],
    scheduler: ["scheduler"],
  };
  for (const [service, names] of Object.entries(expected)) {
    const objectives = await createCoreServiceObjectives(service);
    assert.deepEqual(Object.keys(objectives).sort(), names);
    for (const objective of Object.values(objectives)) {
      for (let round = 0; round < 3; round += 1) assert.equal(typeof await objective(), "object");
    }
  }
});
