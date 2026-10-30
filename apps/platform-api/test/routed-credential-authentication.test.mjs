import assert from "node:assert/strict";
import { test } from "node:test";

import { RoutedCredentialAuthentication } from "../src/identity/routed-credential-authentication.mjs";

test("credential authentication routes disjoint Agent and persistent API token namespaces without fallback", async () => {
  const calls = [];
  const authentication = new RoutedCredentialAuthentication({
    agent: { async authenticate(input) { calls.push("agent"); return { identityId: "agent", secret: input.secret }; } },
    api: { async authenticate(input) { calls.push("api"); return { identityId: "api", secret: input.secret }; } },
  });
  assert.equal((await authentication.authenticate({ secret: "taib_agent_v1.payload.signature" })).identityId, "agent");
  assert.equal((await authentication.authenticate({ secret: `taib_sk_${"A".repeat(43)}` })).identityId, "api");
  await assert.rejects(authentication.authenticate({ secret: "unknown-token" }), { code: "invalid_credential" });
  assert.deepEqual(calls, ["agent", "api"]);
});
