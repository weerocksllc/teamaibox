import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { MemoryPipCatalog, MemoryPipContentStore } from "../gateways/pip/src/memory-pip-catalog.mjs";
import { PipGatewayService } from "../gateways/pip/src/pip-gateway-service.mjs";
import { PipSimpleHttpApi } from "../gateways/pip/src/pip-simple-http-api.mjs";
import { createPipGatewayServer } from "../gateways/pip/server/pip-gateway-server.mjs";

const execute = promisify(execFile);
const ADMIN = "018f6f18-24d7-7c21-9b62-8c017419958b";
const SOURCE = "018f6f18-24d7-7c21-9b62-8c0174199501";

test("a real pip client installs a verified wheel through the internal Simple API", { timeout: 30_000 }, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "teamaibox-pip-client-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const wheelPath = join(temporary, "demo_package-1.0.0-py3-none-any.whl");
  const generator = [
    "import sys,zipfile",
    "p=sys.argv[1]",
    "files={'demo_package/__init__.py':\"VALUE = 'installed-through-gateway'\\n\",'demo_package-1.0.0.dist-info/METADATA':'Metadata-Version: 2.1\\nName: demo-package\\nVersion: 1.0.0\\n','demo_package-1.0.0.dist-info/WHEEL':'Wheel-Version: 1.0\\nGenerator: teamaibox-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n','demo_package-1.0.0.dist-info/RECORD':''}",
    "z=zipfile.ZipFile(p,'w',zipfile.ZIP_DEFLATED)",
    "[z.writestr(k,v) for k,v in files.items()]",
    "z.close()",
  ].join(";");
  await execute("python3", ["-c", generator, wheelPath]);
  const bytes = await readFile(wheelPath), sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const policy = { policyKey: "pip.test", offlineMode: "require-offline", packageRules: [], sources: [{ sourceId: SOURCE, priority: 1, source: { sourceId: SOURCE, kind: "hosted", enabled: true, onlineMode: "offline", packageScopes: ["*"] } }] };
  const service = new PipGatewayService({ catalog: new MemoryPipCatalog(), content: new MemoryPipContentStore(), policyResolver: { resolve: async () => policy } });
  const context = { identityId: ADMIN, permissions: ["source:manage"], architecture: "arm64", environment: "agent" };
  await service.importArtifact({ context, artifact: { project: "demo-package", version: "1.0.0", filename: "demo_package-1.0.0-py3-none-any.whl", sha256, size: bytes.byteLength, sourceId: SOURCE, sourceKind: "hosted", locationKey: "pip/test/demo.whl", requiresPython: ">=3.8", dependencies: [], architectures: ["all"], signatureStatus: "not-available", scanStatus: "passed", license: "MIT" }, bytes });
  const server = createPipGatewayServer({ api: new PipSimpleHttpApi({ service }), contextResolver: { resolve: async () => context } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address(), target = join(temporary, "target");
  await execute("python3", ["-m", "pip", "install", "--disable-pip-version-check", "--no-deps", "--no-cache-dir", "--index-url", `http://127.0.0.1:${address.port}/pip/simple/`, "--target", target, "demo-package==1.0.0"], { timeout: 20_000 });
  const installed = await readFile(join(target, "demo_package", "__init__.py"), "utf8");
  assert.match(installed, /installed-through-gateway/);
});
