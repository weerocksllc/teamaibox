import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dockerfile = new URL(
  "../../../deploy/images/platform-api.Dockerfile",
  import.meta.url,
);

test("production platform image carries its pinned interpreter and only the local entrypoint", async () => {
  const source = await readFile(dockerfile, "utf8");
  assert.match(source, /ARG PYTHON_IMAGE=.*@sha256:[0-9a-f]{64}/);
  assert.match(source, /COPY --from=validator-runtime \/usr\/local\/bin\/python3 /);
  assert.match(source, /ENTRYPOINT \["node", "\/opt\/teamaibox\/apps\/platform-api\/server\/appliance-main\.mjs"\]/);
  assert.doesNotMatch(source, /spark23|application-catalog-e2e|fine-tuning-runtime\.json|maintenance-runtime\.dual/);
});
