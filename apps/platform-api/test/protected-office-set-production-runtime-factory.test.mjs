import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  createProtectedOfficeSetProductionRuntimeFactory,
  loadProtectedOfficeSetRuntimeBundleFromEnvironment,
  protectedOfficeSetProductionRuntimeFactoryContract,
} from "../server/protected-office-set-production-runtime-factory.mjs";

function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function digestBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function digestDocument(value) {
  return digestBytes(Buffer.from(canonical(value), "utf8"));
}

async function bundleFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "teamaibox-protected-office-v5-bundle-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const planPath = join(root, protectedOfficeSetProductionRuntimeFactoryContract.planRelativePath);
  await mkdir(dirname(planPath), { recursive: true });
  const containerId = "7".repeat(64);
  const nodeId = "00000000-0000-5000-8000-000000000001";
  const nodeAgentIdentity = {
    containerName: "teamaibox-node-agent",
    containerId: "6".repeat(64),
    imageId: `sha256:${"5".repeat(64)}`,
    imageReference: `registry.local/teamaibox/node-agent@sha256:${"4".repeat(64)}`,
    configDigest: `sha256:${"3".repeat(64)}`,
    state: "running",
    stateVolume: "teamaibox-node-agent-state",
    journalPath: "/var/lib/teamaibox/node-agent/protected-set-transition-journal.v1.json",
    managedEndpoint: "https://10.64.0.20:19443",
    certificatePin: `sha256:${"8".repeat(64)}`,
  };
  const migration = {
    path: "evidence/validation/feature-deployments/legacy-to-canonical-protected-office-set-20260905-a1.json",
    runnerId: "teamaibox.legacy-to-canonical-protected-office-set.v1",
    runId: "legacy-to-canonical-protected-office-set-20260905-a1",
    evidenceDigest: `sha256:${"2".repeat(64)}`,
    validator: "tools/validate_legacy_to_canonical_protected_office_set.py",
  };
  const protectedWorkerAuthorities = Array.from({ length: 6 }, (_unused, index) => ({
    slot: `slot-${index + 1}`,
    workerId: `00000000-0000-5000-8000-${String(index + 11).padStart(12, "0")}`,
    modelProfileId: `00000000-0000-5000-8000-${String(index + 21).padStart(12, "0")}`,
    leaseId: "00000000-0000-5000-8000-000000000031",
    fencingToken: 11,
    nodeGeneration: 4,
  }));
  const capturePath = "evidence/validation/feature-deployments/protected-office-set-v5-runtime-capture-20260905-a1.json";
  const captureEvidence = {
    schemaVersion: 1,
    runnerId: protectedOfficeSetProductionRuntimeFactoryContract.bootstrapCaptureRunnerId,
    runId: "protected-office-set-v5-runtime-capture-20260905-a1",
    status: "passed",
    capturedAt: "2026-09-05T12:00:00Z",
    migration,
    target: {
      nodeId,
      nodeGeneration: 4,
      candidatePlatform: {
        containerName: "teamaibox-platform-api",
        containerId,
        imageId: `sha256:${"1".repeat(64)}`,
        imageReference: `registry.local/teamaibox/platform@sha256:${"a".repeat(64)}`,
        configDigest: `sha256:${"b".repeat(64)}`,
        state: "created",
        mount: {
          type: "volume",
          source: "teamaibox-protected-office-v5-bundle-a1",
          destination: root,
          readOnly: true,
        },
        environment: {
          PLATFORM_PROTECTED_OFFICE_SET_DEPLOYMENT_ID:
            protectedOfficeSetProductionRuntimeFactoryContract.deploymentId,
          PLATFORM_PROTECTED_OFFICE_SET_BUNDLE_ROOT: root,
          PLATFORM_PROTECTED_OFFICE_SET_BUNDLE_MANIFEST_FILE: join(root, "bundle-manifest.json"),
          PLATFORM_PROTECTED_OFFICE_SET_REPOSITORY_ROOT: root,
          PLATFORM_PROTECTED_OFFICE_SET_DEPLOYMENT_PLAN_FILE: planPath,
          PLATFORM_PROTECTED_OFFICE_SET_NODE_ID: nodeId,
          PLATFORM_PROTECTED_OFFICE_SET_NODE_GENERATION: "4",
        },
      },
      nodeAgentIdentity,
      protectedWorkerAuthorities,
    },
    set: { desiredStateRevision: 20, maintenanceGeneration: 7 },
    bundle: {
      volumeName: "teamaibox-protected-office-v5-bundle-a1",
      destination: root,
      manifestFile: join(root, "bundle-manifest.json"),
      planFile: planPath,
      readOnly: true,
      bundleInstalled: false,
      candidateCreatedBeforePlan: true,
      containerRecreatedAfterPlan: false,
    },
    privacy: {
      credentialsRetained: false,
      environmentSecretsRetained: false,
      commandOutputRetained: false,
      userContentRetained: false,
    },
    claimBoundary: {
      migrationComplete: true,
      candidateContainerCaptured: true,
      bundleInstalled: false,
      v5PlanGenerated: false,
      task21_4Complete: false,
    },
  };
  captureEvidence.evidenceDigest = digestDocument(captureEvidence);
  const captureFile = join(root, capturePath);
  await mkdir(dirname(captureFile), { recursive: true });
  const captureBytes = Buffer.from(JSON.stringify(captureEvidence, null, 2) + "\n", "utf8");
  await writeFile(captureFile, captureBytes);
  const capture = {
    runnerId: protectedOfficeSetProductionRuntimeFactoryContract.bootstrapCaptureRunnerId,
    runId: captureEvidence.runId,
    path: capturePath,
    evidenceDigest: captureEvidence.evidenceDigest,
  };
  const plan = {
    schemaVersion: 1,
    deploymentId: protectedOfficeSetProductionRuntimeFactoryContract.deploymentId,
    readyForExecution: true,
    target: {
      nodeId,
      nodeGeneration: 4,
      platformIdentity: {
        containerName: "teamaibox-platform-api",
        containerId,
        imageId: `sha256:${"1".repeat(64)}`,
        imageReference: `registry.local/teamaibox/platform@sha256:${"a".repeat(64)}`,
        configDigest: `sha256:${"b".repeat(64)}`,
        state: "running",
      },
      nodeAgentIdentity,
    },
    parents: { legacyCanonicalDeployment: migration },
    set: {
      desiredStateRevision: 20,
      maintenanceGeneration: 7,
      profiles: protectedWorkerAuthorities.map((authority) => ({
        slot: authority.slot,
        priorState: {
          authority: {
            leaseId: authority.leaseId,
            fencingToken: authority.fencingToken,
            nodeGeneration: authority.nodeGeneration,
          },
          target: {
            workerId: authority.workerId,
            modelProfileId: authority.modelProfileId,
          },
        },
      })),
    },
    runtimeBundle: {
      schemaVersion: 1,
      root,
      manifestFile: join(root, "bundle-manifest.json"),
      planFile: planPath,
      mount: {
        type: "volume", source: "teamaibox-protected-office-v5-bundle-a1",
        destination: root, readOnly: true,
      },
      bootstrapCapture: capture,
      candidateCreatedBeforePlan: true,
      containerRecreatedAfterPlan: false,
    },
  };
  const planBytes = Buffer.from(JSON.stringify(plan, null, 2) + "\n", "utf8");
  await writeFile(planPath, planBytes);
  const manifest = {
    schemaVersion: 1,
    bundleId: protectedOfficeSetProductionRuntimeFactoryContract.bundleId,
    deploymentId: protectedOfficeSetProductionRuntimeFactoryContract.deploymentId,
    plan: {
      path: protectedOfficeSetProductionRuntimeFactoryContract.planRelativePath,
      sha256: digestBytes(planBytes),
    },
    bootstrapCapture: capture,
    installation: {
      candidatePlatformContainerId: containerId,
      candidateCreatedBeforePlan: true,
      containerRecreatedAfterPlan: false,
      mountSource: "teamaibox-protected-office-v5-bundle-a1",
      mountDestination: root,
      mountReadOnly: true,
    },
    files: [
      {
        path: protectedOfficeSetProductionRuntimeFactoryContract.planRelativePath,
        sha256: digestBytes(planBytes),
      },
      { path: capturePath, sha256: digestBytes(captureBytes) },
    ],
  };
  manifest.manifestDigest = digestDocument(manifest);
  const manifestPath = join(root, "bundle-manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return {
    root,
    planPath,
    manifestPath,
    environment: {
      PLATFORM_PROTECTED_OFFICE_SET_DEPLOYMENT_ID:
        protectedOfficeSetProductionRuntimeFactoryContract.deploymentId,
      PLATFORM_PROTECTED_OFFICE_SET_BUNDLE_ROOT: root,
      PLATFORM_PROTECTED_OFFICE_SET_BUNDLE_MANIFEST_FILE: manifestPath,
    },
  };
}

test("loads an exact post-create v5 runtime bundle without self-reference", async (t) => {
  const fixture = await bundleFixture(t);
  const loaded = await loadProtectedOfficeSetRuntimeBundleFromEnvironment(fixture.environment, {
    expectedRoot: fixture.root,
  });
  assert.equal(loaded.root, fixture.root);
  assert.equal(loaded.planFile, fixture.planPath);
  assert.equal(loaded.manifest.installation.candidateCreatedBeforePlan, true);
  assert.equal(loaded.manifest.installation.containerRecreatedAfterPlan, false);

  const expandedManifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  expandedManifest.unexpected = true;
  delete expandedManifest.manifestDigest;
  expandedManifest.manifestDigest = digestDocument(expandedManifest);
  await writeFile(fixture.manifestPath, JSON.stringify(expandedManifest, null, 2) + "\n");
  await assert.rejects(
    loadProtectedOfficeSetRuntimeBundleFromEnvironment(fixture.environment, { expectedRoot: fixture.root }),
    /manifest.*shape/,
  );
  delete expandedManifest.unexpected;
  delete expandedManifest.manifestDigest;
  expandedManifest.manifestDigest = digestDocument(expandedManifest);
  await writeFile(fixture.manifestPath, JSON.stringify(expandedManifest, null, 2) + "\n");

  await writeFile(fixture.planPath, "{}\n");
  await assert.rejects(
    loadProtectedOfficeSetRuntimeBundleFromEnvironment(fixture.environment, { expectedRoot: fixture.root }),
    /bundle file drifted/,
  );
});

test("composes v5 wiring and production scenarios through one explicit boundary factory", async () => {
  const calls = [];
  const factory = createProtectedOfficeSetProductionRuntimeFactory({
    async bundleLoader() {
      return { root: "/bundle", planFile: "/bundle/deploy/compute/protected-office-set-deployment.v5.json" };
    },
    async wiringFactory(_environment, dependencies) {
      calls.push(["wiring", dependencies.repositoryRoot, dependencies.deploymentId]);
      assert.equal(dependencies.leaseAuthorityProvider.kind, "real-boundary");
      return {
        services: { protectedOfficeSetBindings: { kind: "exact-bindings" } },
        async close() { calls.push(["wiring-close"]); },
      };
    },
    async runtimeFactory(_environment, services) {
      calls.push(["runtime", services.protectedOfficeSetBindings.kind]);
      assert.equal(services.fetcher.kind, "pinned-public-https");
      assert.deepEqual(services.requiredCoreServiceKeys, ["platform-api"]);
      return {
        protectedOfficeSetControlService: { kind: "production-runtime" },
        async close() { calls.push(["runtime-close"]); },
      };
    },
  });
  const runtime = await factory({}, {
    async protectedOfficeSetProductionBoundaryFactory(_environment, { bundle }) {
      assert.equal(bundle.root, "/bundle");
      const publicHttpsInspectionFetcher = Object.assign(async () => {}, { kind: "pinned-public-https" });
      return {
        leaseAuthorityProvider: { kind: "real-boundary" },
        publicHttpsInspectionFetcher,
        requiredCoreServiceKeys: ["platform-api"],
      };
    },
  });
  assert.equal(runtime.protectedOfficeSetControlService.kind, "production-runtime");
  await runtime.close();
  await runtime.close();
  assert.deepEqual(calls, [
    ["wiring", "/bundle", protectedOfficeSetProductionRuntimeFactoryContract.deploymentId],
    ["runtime", "exact-bindings"],
    ["runtime-close"],
    ["wiring-close"],
  ]);
});

test("fails closed when no production boundary factory is registered", async () => {
  const factory = createProtectedOfficeSetProductionRuntimeFactory({
    async bundleLoader() { return { root: "/bundle" }; },
  });
  await assert.rejects(factory({}, {}), /production boundary factory is unavailable/);
});

test("forward boot receipt binds every recreated Worker and cannot revive an older epoch", async (t) => {
  const fixture = await bundleFixture(t);
  const manifest = JSON.parse(await readFile(fixture.manifestPath));
  const capturePath = join(fixture.root, manifest.bootstrapCapture.path);
  const capture = JSON.parse(await readFile(capturePath));
  const plan = JSON.parse(await readFile(fixture.planPath));
  const recoveryPath = 'evidence/validation/host-maintenance/generation-recovery-test.json';
  const receipt = {
    schemaVersion: 1, runnerId: 'teamaibox.main-box-generation-recovery.v1',
    runId: 'generation-recovery-test', status: 'passed', nodeId: capture.target.nodeId,
    previousGeneration: 3, nodeGeneration: 4,
    desiredStateRevision: capture.set.desiredStateRevision,
    maintenanceGeneration: capture.set.maintenanceGeneration,
    transactionId: capture.target.protectedWorkerAuthorities[0].leaseId,
    fencingToken: 11, terminalPhase: 'complete', originalHistoryPreserved: true,
    credentialsRetained: false, userContentRetained: false,
    journalDigest: `sha256:${'1'.repeat(64)}`,
    beforeInventoryDigest: `sha256:${'2'.repeat(64)}`, afterInventoryDigest: `sha256:${'3'.repeat(64)}`,
    workers: capture.target.protectedWorkerAuthorities.map(a => ({
      workerId: a.workerId, modelProfileId: a.modelProfileId, leaseId: a.leaseId,
      fencingToken: a.fencingToken, previousContainerId: '4'.repeat(64), containerId: '5'.repeat(64),
      imageId: `sha256:${'6'.repeat(64)}`, configurationDigest: `sha256:${'7'.repeat(64)}`,
      startSpecDigest: `sha256:${'8'.repeat(64)}`, healthy: true, modelAndRuntimeUnchanged: true,
    })),
  };
  async function install() {
    delete receipt.evidenceDigest; receipt.evidenceDigest = digestDocument(receipt);
    capture.schemaVersion = 2;
    capture.generationRecovery = { path: recoveryPath, runnerId: receipt.runnerId,
      runId: receipt.runId, evidenceDigest: receipt.evidenceDigest };
    delete capture.evidenceDigest; capture.evidenceDigest = digestDocument(capture);
    plan.runtimeBundle.bootstrapCapture.evidenceDigest = capture.evidenceDigest;
    manifest.bootstrapCapture.evidenceDigest = capture.evidenceDigest;
    const files = [[recoveryPath, receipt], [manifest.bootstrapCapture.path, capture],
      [manifest.plan.path, plan]];
    for (const [path, doc] of files) {
      await mkdir(dirname(join(fixture.root, path)), { recursive: true });
      const bytes = Buffer.from(JSON.stringify(doc));
      await writeFile(join(fixture.root, path), bytes);
      manifest.files = manifest.files.filter(f => f.path !== path);
      manifest.files.push({ path, sha256: digestBytes(bytes) });
    }
    manifest.files.sort((a, b) => a.path.localeCompare(b.path));
    manifest.plan.sha256 = manifest.files.find(f => f.path === manifest.plan.path).sha256;
    delete manifest.manifestDigest; manifest.manifestDigest = digestDocument(manifest);
    await writeFile(fixture.manifestPath, JSON.stringify(manifest));
  }
  const load = () => loadProtectedOfficeSetRuntimeBundleFromEnvironment(fixture.environment, { expectedRoot: fixture.root });
  await install(); await load();
  receipt.previousGeneration = 4; await install();
  await assert.rejects(load, /forward generation recovery/);
  receipt.previousGeneration = 3; receipt.workers[2].healthy = false; await install();
  await assert.rejects(load, /forward generation recovery/);
  receipt.workers[2].healthy = true; receipt.workers[5].containerId = receipt.workers[5].previousContainerId; await install();
  await assert.rejects(load, /forward generation recovery/);
});
