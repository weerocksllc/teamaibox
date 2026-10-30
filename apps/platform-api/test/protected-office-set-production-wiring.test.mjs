import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  createProtectedOfficeSetFaultController,
  createProtectedOfficeSetMaintenanceContextProvider,
  createProtectedOfficeSetParentEvidenceVerifier,
  createProtectedOfficeSetPlanBindings,
  createProtectedOfficeSetPlatformLifecycleController,
  createProtectedOfficeSetProductionWiringFromEnvironment,
  createProtectedOfficeSetPublicHttpsScenarioRunner,
  loadProtectedOfficeSetDeploymentPlan,
  protectedOfficeSetProductionWiringContract,
  protectedOfficeSetProductionWiringV5Contract,
} from "../server/protected-office-set-production-wiring.mjs";

const GiB = 2 ** 30;
const PLAN_PATH = "deploy/compute/protected-office-set-deployment.v2.json";
const NODE = uuid(1);
const GROUP = uuid(2);
const ACTION = uuid(3);
const IDEMPOTENCY = sha("f");

function uuid(number) {
  return `00000000-0000-5000-8000-${String(number).padStart(12, "0")}`;
}

function sha(character) { return `sha256:${character.repeat(64)}`; }

function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function bytesDigest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "teamaibox-protected-wiring-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path, value) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    await writeFile(target, bytes);
    return bytesDigest(bytes);
  };

  const manifestDigest = await write("deploy/compute/protected-office-profile-set.v1.json", {
    schemaVersion: 1, setId: "office.baseline",
  });
  const adapterDigest = await write("tools/protected_office_set_deployment_adapter.mjs", "export default true;\n");
  const inspectionAdapterDigest = await write("tools/protected_office_set_inspection_adapter.mjs", "export default true;\n");
  const driverDigest = await write("apps/platform-api/server/fixture-driver.mjs", "export default true;\n");
  const inspectorDigest = await write("apps/platform-api/server/fixture-inspector.mjs", "export default true;\n");

  const parentDefinitions = [
    ["profileSetQualification", "profile", "teamaibox.profile.v1", {
      claimBoundary: {
        manifestComplete: true,
        task21_3Complete: true,
        protectedOfficeSetDeployed: false,
        task21_4Complete: false,
      },
    }],
    ["schemaDeployment", "schema", "teamaibox.schema.v1", {}],
    ["legacyCanonicalDeployment", "legacy", "teamaibox.legacy.v1", {
      claimBoundary: { canonicalSixDeployed: true, durableCutoverRecoveryQualified: true },
    }],
  ];
  const parents = {};
  for (const [name, stem, runnerId, extras] of parentDefinitions) {
    const evidence = {
      schemaVersion: 1,
      runId: `protected-office-${stem}-20260905-a1`,
      runnerId,
      status: "passed",
      ...extras,
    };
    evidence.evidenceDigest = digest(evidence);
    const path = `evidence/validation/feature-deployments/${stem}.json`;
    await write(path, evidence);
    const validator = `tools/validate_${stem}.py`;
    await write(validator, "#!/usr/bin/env python3\n");
    parents[name] = {
      path,
      runnerId,
      runId: evidence.runId,
      evidenceDigest: evidence.evidenceDigest,
      validator,
      ...(name === "profileSetQualification" ? { requiredFacts: [
        { pointer: "/claimBoundary/manifestComplete", equals: true },
        { pointer: "/claimBoundary/task21_4Complete", equals: false },
      ] } : {}),
      ...(name === "legacyCanonicalDeployment" ? { requiredFacts: [
        { pointer: "/claimBoundary/canonicalSixDeployed", equals: true },
      ] } : {}),
    };
  }

  const slots = [
    "embedding-qwen3", "asr-whisper", "ocr-hunyuan",
    "translation-lmt4", "assistant-qwen38", "drawing-flux2",
  ];
  const accounting = [6, 2, 6, 10, 32, 8].map((value) => value * GiB);
  const profiles = [];
  for (const [index, slot] of slots.entries()) {
    const workerId = uuid(100 + index);
    const modelProfileId = uuid(200 + index);
    const attemptId = uuid(300 + index);
    const imageId = sha(String.fromCharCode(97 + index));
    const imageDigest = sha(String(index + 1));
    const configurationPath = `deploy/compute/${slot}.json`;
    const configurationDigest = await write(configurationPath, {
      profileId: modelProfileId,
      profileKey: `${slot}.main-protected.v1`,
      placementClass: "protected-resident",
    });
    const requiredLabels = {
      "com.teamaibox.worker-id": workerId,
      "com.teamaibox.model-profile-id": modelProfileId,
      "com.teamaibox.placement-class": "protected-resident",
      "com.teamaibox.office-slot": slot,
    };
    const workerStart = {
      workerId,
      attemptId,
      modelProfileId,
      workloadKind: "compute-worker",
      image: `registry.local/teamaibox/${slot}@${imageDigest}`,
      network: "compute-internal",
      limits: {
        memoryBytes: accounting[index], cpuQuotaMicros: 100_000,
        pidsLimit: 256, ephemeralBytes: GiB,
        sharedMemoryBytes: 64 * 1024 ** 2, openFilesLimit: 4096,
      },
      security: {
        runAsUid: 10001, runAsGid: 10001,
        readOnlyRoot: true, dropAllCapabilities: true, noNewPrivileges: true,
        privileged: false, hostPid: false, hostIpc: false, hostNetwork: false, dockerSocket: false,
      },
      entrypoint: ["/usr/bin/teamaibox-worker", "--serve"],
      placementClass: "protected-resident",
      maintenanceGeneration: 7,
      configDigest: configurationDigest,
      nodeId: NODE,
      nodeGeneration: 4,
    };
    profiles.push({
      slot,
      modelProfileId,
      profileKey: `${slot}.main-protected.v1`,
      profileConfiguration: configurationPath,
      workerId,
      attemptId,
      targetKey: `office.${slot}`,
      containerName: `teamaibox-worker-${workerId}`,
      imageId,
      imageReference: workerStart.image,
      configurationDigest,
      declaredResidentBytes: accounting[index],
      stageOrder: index + 1,
      dependsOnSlots: index === 0 ? [] : [slots[0]],
      requiredLabels,
      dependentContainers: [],
      workerStart,
      priorState: {
        mode: "exact-canonical",
        authority: {
          leaseId: uuid(500 + index),
          fencingToken: 11,
          nodeGeneration: 4,
        },
        target: {
          targetKey: `office.${slot}`,
          workerId,
          modelProfileId: uuid(400 + index),
          containerName: `teamaibox-worker-${workerId}`,
          placementClass: "protected-resident",
          maintenanceGeneration: 6,
          stageOrder: index + 1,
          ...(index === 0 ? {} : { dependsOnWorkerIds: [uuid(100)] }),
          requiredImageId: sha(String(index + 1)),
          requiredImageDigest: `registry.local/teamaibox/legacy-${slot}@${sha("abcdef"[index])}`,
          requiredConfigDigest: sha("fedcba"[index]),
          requiredStartSpecDigest: sha("012345"[index]),
          requiredLabels: { "com.teamaibox.worker-id": workerId },
          dependentContainers: [],
        },
      },
    });
  }
  const runtimeIdentity = (containerName, character) => ({
    containerName,
    containerId: character.repeat(64),
    imageId: sha(character),
    imageReference: `registry.local/teamaibox/${containerName}@${sha("b")}`,
    configDigest: sha("c"),
    state: "running",
  });
  const plan = {
    schemaVersion: 1,
    deploymentId: "teamaibox.protected-office-set-deployment.v2",
    readyForExecution: true,
    target: {
      ssh: "operator@10.64.0.20", nodeAddress: "10.64.0.20", nodeRole: "main-box",
      nodeGroupId: GROUP, nodeId: NODE, nodeGeneration: 4,
      platformContainer: "teamaibox-platform-api",
      nodeAgentContainer: "teamaibox-node-agent",
      platformIdentity: runtimeIdentity("teamaibox-platform-api", "7"),
      nodeAgentIdentity: runtimeIdentity("teamaibox-node-agent", "8"),
    },
    parents,
    profileSetManifest: {
      path: "deploy/compute/protected-office-profile-set.v1.json",
      sha256: manifestDigest,
    },
    budget: {
      aggregateAccountingRule: "sum(max(observedResidentBytes,observedPeakBytes))",
      modelTargetBytes: 64 * GiB,
      coreServiceReserveBytes: 32 * GiB,
      transientMarginBytes: 16 * GiB,
      ordinaryPerProfile96GiBGateApplied: false,
    },
    set: {
      setId: "office.baseline", desiredStateRevision: 20, maintenanceGeneration: 7, profiles,
    },
    controller: {
      adapterDigest,
      driverSourcePath: "apps/platform-api/server/fixture-driver.mjs",
      driverModuleDigest: driverDigest,
      inspectionAdapterDigest,
      inspectorSourcePath: "apps/platform-api/server/fixture-inspector.mjs",
      inspectorModuleDigest: inspectorDigest,
    },
    qualification: {
      faultInjection: {
        slot: "drawing-flux2", failAfterStageOrder: 5,
        expectedFailureCode: "protected_set_transition_stage_failed",
      },
    },
  };
  await write(PLAN_PATH, plan);
  return {
    root,
    plan,
    planFile: join(root, PLAN_PATH),
    evidenceFile: join(root, parents.profileSetQualification.path),
    write,
  };
}

function productionAdapters(value, calls = []) {
  return {
    leaseAuthorityProvider: {
      async getAuthority(request) {
        calls.push(["authority", request]);
        return { leaseId: uuid(900), fencingToken: 41, nodeGeneration: 4 };
      },
    },
    realtimePlacementResolver: { async resolve(request) { calls.push(["placement", request]); return []; } },
    coreServiceProbe: {
      async probe(request) {
        calls.push(["core", request]);
        return {
          healthy: true, nodeId: request.nodeId, setId: request.setId, phase: request.phase,
          coreServiceReserveBytes: 32 * GiB, transientMarginBytes: 16 * GiB,
          source: "authenticated-core-service-probe", observedAt: "2026-09-05T12:00:00.000Z",
        };
      },
    },
  };
}

function request(snapshot) {
  return {
    runId: "protected-office-set-deployment-20260905-a1",
    actionId: ACTION,
    idempotencyKey: IDEMPOTENCY,
    plan: structuredClone(snapshot.plan),
  };
}

test("rejects the checked-in unresolved planning skeleton and symbolic plan replacement", async (t) => {
  const repositoryRoot = await realpath(join(import.meta.dirname, "../../.."));
  await assert.rejects(loadProtectedOfficeSetDeploymentPlan({
    repositoryRoot,
    planFile: join(repositoryRoot, PLAN_PATH),
  }), /not execution-ready/);

  const files = await fixture(t);
  const realPlan = join(files.root, "plan-real.json");
  await writeFile(realPlan, await readFile(files.planFile));
  await rm(files.planFile);
  await symlink(realPlan, files.planFile);
  await assert.rejects(loadProtectedOfficeSetDeploymentPlan({
    repositoryRoot: files.root, planFile: files.planFile,
  }), /symbolic link/);
});

test("strictly loads the exact six-profile execution plan and detects source drift", async (t) => {
  const files = await fixture(t);
  const snapshot = await loadProtectedOfficeSetDeploymentPlan({
    repositoryRoot: files.root, planFile: files.planFile,
  });
  assert.equal(snapshot.plan.readyForExecution, true);
  assert.equal(snapshot.aggregateBytes, 64 * GiB);
  assert.equal(Object.isFrozen(snapshot.plan), true);
  assert.equal(snapshot.plan.set.profiles.length, 6);

  await writeFile(join(files.root, "apps/platform-api/server/fixture-driver.mjs"), "drift\n");
  await assert.rejects(loadProtectedOfficeSetDeploymentPlan({
    repositoryRoot: files.root, planFile: files.planFile,
  }), /production driver source digest drifted/);
});

test("deployment target uses explicit installation configuration and binds SSH to its address", async (t) => {
  const files = await fixture(t);
  files.plan.target.nodeAddress = "10.64.0.42";
  files.plan.target.ssh = "operator@10.64.0.42";
  await writeFile(files.planFile, JSON.stringify(files.plan));
  const snapshot = await loadProtectedOfficeSetDeploymentPlan({ repositoryRoot: files.root, planFile: files.planFile });
  assert.equal(snapshot.plan.target.nodeAddress, "10.64.0.42");
  for (const ssh of ["operator@10.64.0.43", "operator@10.64.0.42 -oProxyCommand=unexpected", "@10.64.0.42"]) {
    files.plan.target.ssh = ssh;
    await writeFile(files.planFile, JSON.stringify(files.plan));
    await assert.rejects(loadProtectedOfficeSetDeploymentPlan({ repositoryRoot: files.root, planFile: files.planFile }), /deployment target drifted/);
  }
});

test("loads v5 only with the post-create read-only bundle contract", async (t) => {
  const files = await fixture(t);
  const path = "deploy/compute/protected-office-set-deployment.v5.json";
  files.plan.deploymentId = protectedOfficeSetProductionWiringV5Contract.deploymentId;
  files.plan.runtimeBundle = {
    schemaVersion: 1,
    root: "/run/teamaibox/protected-office-set/bundle",
    manifestFile: "/run/teamaibox/protected-office-set/bundle/bundle-manifest.json",
    planFile: `/run/teamaibox/protected-office-set/bundle/${path}`,
    mount: {
      type: "volume", source: "teamaibox-protected-office-v5-bundle-a1",
      destination: "/run/teamaibox/protected-office-set/bundle", readOnly: true,
    },
    bootstrapCapture: {
      path: "evidence/validation/feature-deployments/protected-office-set-v5-runtime-capture-20260905-a1.json",
      runnerId: protectedOfficeSetProductionWiringV5Contract.bootstrapCaptureRunnerId,
      runId: "protected-office-set-v5-runtime-capture-20260905-a1",
      evidenceDigest: sha("9"),
    },
    candidateCreatedBeforePlan: true,
    containerRecreatedAfterPlan: false,
  };
  await files.write(path, files.plan);
  const planFile = join(files.root, path);
  const snapshot = await loadProtectedOfficeSetDeploymentPlan({
    repositoryRoot: files.root,
    planFile,
    deploymentId: protectedOfficeSetProductionWiringV5Contract.deploymentId,
    planRelativePath: path,
  });
  assert.equal(snapshot.plan.deploymentId, protectedOfficeSetProductionWiringV5Contract.deploymentId);
  assert.equal(snapshot.plan.runtimeBundle.candidateCreatedBeforePlan, true);

  files.plan.runtimeBundle.containerRecreatedAfterPlan = true;
  await files.write("deploy/compute/drifted-v5.json", files.plan);
  await writeFile(planFile, JSON.stringify(files.plan));
  await assert.rejects(loadProtectedOfficeSetDeploymentPlan({
    repositoryRoot: files.root,
    planFile,
    deploymentId: protectedOfficeSetProductionWiringV5Contract.deploymentId,
    planRelativePath: path,
  }), /runtime bundle boundary drifted/);
});

test("constructs desired and exact-prior bindings, targets, set provider and core probe", async (t) => {
  const files = await fixture(t);
  const snapshot = await loadProtectedOfficeSetDeploymentPlan({
    repositoryRoot: files.root, planFile: files.planFile,
  });
  const calls = [];
  const bindings = createProtectedOfficeSetPlanBindings({
    planSnapshot: snapshot,
    ...productionAdapters(files, calls),
  });
  const set = await bindings.protectedSetProvider({ nodeId: NODE });
  assert.equal(set.profiles.length, 6);
  assert.deepEqual(set.profiles.map((profile) => profile.stageOrder), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(set.profiles[1].dependsOnWorkerIds, [set.profiles[0].workerId]);

  const desired = await bindings.bindingFactory({ profile: set.profiles[0], purpose: "transition" });
  assert.equal(desired.worker.modelProfileId, set.profiles[0].modelProfileId);
  assert.equal(desired.worker.nodeId, NODE);
  assert.equal(desired.authority.fencingToken, 41);
  const target = await bindings.maintenanceTargetFactory({ profile: set.profiles[0], purpose: "desired" });
  assert.equal(target.requiredImageDigest, files.plan.set.profiles[0].imageReference);
  assert.match(target.requiredStartSpecDigest, /^sha256:[a-f0-9]{64}$/);

  const priorTarget = files.plan.set.profiles[0].priorState.target;
  const previous = {
    ...set.profiles[0],
    modelProfileId: priorTarget.modelProfileId,
    imageDigest: priorTarget.requiredImageDigest.split("@")[1],
    configurationDigest: priorTarget.requiredConfigDigest,
    maintenanceGeneration: priorTarget.maintenanceGeneration,
    state: "running",
  };
  const priorBinding = await bindings.bindingFactory({
    profile: previous, previousIdentity: previous, purpose: "restore",
  });
  assert.equal(priorBinding.worker.image, priorTarget.requiredImageDigest);
  assert.equal(priorBinding.authority.leaseId, files.plan.set.profiles[0].priorState.authority.leaseId);
  assert.equal(priorBinding.authority.fencingToken, 11);
  const rollbackBinding = await bindings.bindingFactory({
    profile: set.profiles[0], previousIdentity: previous, purpose: "restore",
  });
  assert.deepEqual(rollbackBinding.worker, priorBinding.worker);
  assert.deepEqual(rollbackBinding.authority, priorBinding.authority);
  const restoredTarget = await bindings.maintenanceTargetFactory({
    profile: previous, previousIdentity: previous, purpose: "previous",
  });
  assert.deepEqual(restoredTarget, priorTarget);

  const core = await bindings.coreServiceProbe({ nodeId: NODE, setId: "office.baseline", phase: "stage-1" });
  assert.equal(core.healthy, true);
  assert.equal(calls.filter(([kind]) => kind === "core").length, 1);
  await assert.rejects(bindings.protectedSetProvider({ nodeId: uuid(999) }), /another node/);
});

test("binding factories fail closed on authority, previous identity, and reserve drift", async (t) => {
  const files = await fixture(t);
  const snapshot = await loadProtectedOfficeSetDeploymentPlan({ repositoryRoot: files.root, planFile: files.planFile });
  const adapters = productionAdapters(files);
  const setBindings = createProtectedOfficeSetPlanBindings({ planSnapshot: snapshot, ...adapters });
  const set = await setBindings.protectedSetProvider({ nodeId: NODE });
  await assert.rejects(setBindings.bindingFactory({
    profile: set.profiles[0],
    previousIdentity: { ...set.profiles[0], modelProfileId: uuid(999) },
    purpose: "restore",
  }), /not bound/);

  const badAuthority = createProtectedOfficeSetPlanBindings({
    planSnapshot: snapshot,
    ...adapters,
    leaseAuthorityProvider: { async getAuthority() { return { leaseId: uuid(9), fencingToken: 0, nodeGeneration: 4 }; } },
  });
  await assert.rejects(badAuthority.bindingFactory({ profile: set.profiles[0], purpose: "stage" }), /authority is invalid/);

  const badCore = createProtectedOfficeSetPlanBindings({
    planSnapshot: snapshot,
    ...adapters,
    coreServiceProbe: { async probe(input) { return {
      healthy: true, ...input, coreServiceReserveBytes: GiB, transientMarginBytes: GiB,
      source: "authenticated-core-service-probe", observedAt: "2026-09-05T12:00:00Z",
    }; } },
  });
  await assert.rejects(badCore.coreServiceProbe({ nodeId: NODE, setId: "office.baseline", phase: "probe" }),
    /did not prove/);
});

test("plan binding forwards the same calibrated reserve to the authenticated probe", async t => {
  const files = await fixture(t), calls = [];
  const snapshot = await loadProtectedOfficeSetDeploymentPlan({ repositoryRoot: files.root, planFile: files.planFile });
  const coreMemoryBudget = { measuredPeakBytes: 19080568832, reserveBytes: 23085449216,
    growthPermille: 1200, evidenceDigest: "1".repeat(64) };
  const bindings = createProtectedOfficeSetPlanBindings({ planSnapshot: snapshot,
    ...productionAdapters(files, calls), coreMemoryBudget });
  await bindings.coreServiceProbe({ nodeId: NODE, setId: "office.baseline", phase: "probe" });
  assert.equal(calls.find(([kind]) => kind === "core")[1].requiredCoreServiceReserveBytes, coreMemoryBudget.reserveBytes);
  assert.throws(() => createProtectedOfficeSetPlanBindings({ planSnapshot: snapshot,
    ...productionAdapters(files), coreMemoryBudget: { ...coreMemoryBudget, reserveBytes: GiB } }), /measured peak/);
});

test("live inspection binds the predecessor until a completed successor transition advances it", async (t) => {
  const files = await fixture(t);
  const snapshot = await loadProtectedOfficeSetDeploymentPlan({ repositoryRoot: files.root, planFile: files.planFile });
  const calls = [];
  const bindings = createProtectedOfficeSetPlanBindings({ planSnapshot: snapshot, ...productionAdapters(files, calls) });
  const { profiles } = await bindings.protectedSetProvider({ nodeId: NODE });
  const expected = profiles[2], prior = files.plan.set.profiles[2].priorState;
  const before = await bindings.bindingFactory({ profile: expected, purpose: "inspect" });
  assert.equal(before.worker.modelProfileId, prior.target.modelProfileId);
  assert.equal(before.worker.image, prior.target.requiredImageDigest);
  assert.equal(before.worker.configDigest, prior.target.requiredConfigDigest);
  assert.deepEqual(before.authority, prior.authority);
  const staging = await bindings.bindingFactory({ profile: expected, purpose: "transition" });
  assert.equal(staging.worker.modelProfileId, expected.modelProfileId);
  assert.equal((await bindings.bindingFactory({ profile: expected, purpose: "inspect" })).worker.image,
    prior.target.requiredImageDigest, "requesting transition authority must not advance live identity");
  bindings.bindingFactory.recordTransition({ transactionId: uuid(920), journalRevision: 44,
    profiles: [expected], previousIdentities: { [expected.workerId]: { state: "running", healthy: true,
      modelProfileId: prior.target.modelProfileId } } });
  const after = await bindings.bindingFactory({ profile: expected, purpose: "inspect" });
  assert.equal(after.worker.modelProfileId, expected.modelProfileId);
  assert.equal(after.worker.configDigest, expected.configurationDigest);
  assert.deepEqual(after.authority, { leaseId: uuid(920), fencingToken: 44, nodeGeneration: 4 });
  const untouched = await bindings.bindingFactory({ profile: profiles[1], purpose: "inspect" });
  assert.equal(untouched.worker.modelProfileId, files.plan.set.profiles[1].priorState.target.modelProfileId);
});

test("revalidates exact parent files, canonical digests, required facts, and validator paths", async (t) => {
  const files = await fixture(t);
  const snapshot = await loadProtectedOfficeSetDeploymentPlan({ repositoryRoot: files.root, planFile: files.planFile });
  const validations = [];
  const verifier = createProtectedOfficeSetParentEvidenceVerifier({
    planSnapshot: snapshot,
    validatorRunner: {
      async runStrictValidator(input) {
        validations.push(input);
        return { status: "passed", exitCode: 0, validatorPath: input.validatorPath, evidencePath: input.evidencePath };
      },
    },
  });
  const result = await verifier.verify({ plan: structuredClone(snapshot.plan) });
  assert.equal(result.parentsValidated, true);
  assert.equal(validations.length, 3);
  assert.ok(validations.every((input) => input.timeoutMilliseconds === 900_000));
  assert.ok(validations.every((input) => input.validatorPath.startsWith(join(files.root, "tools/validate_"))));

  const evidence = JSON.parse(await readFile(files.evidenceFile, "utf8"));
  evidence.status = "failed";
  await writeFile(files.evidenceFile, JSON.stringify(evidence));
  await assert.rejects(verifier.verify({ plan: structuredClone(snapshot.plan) }), /digest drifted/);
});

test("public HTTPS, unsigned maintenance, fault, and lifecycle adapters never simulate success", async (t) => {
  const files = await fixture(t);
  const snapshot = await loadProtectedOfficeSetDeploymentPlan({ repositoryRoot: files.root, planFile: files.planFile });
  const base = request(snapshot);
  const jobs = Object.fromEntries(protectedOfficeSetProductionWiringContract.capabilities
    .filter((capability) => !new Set(["assistant.agent", "asr.realtime"]).has(capability))
    .map((capability, index) => [capability, uuid(500 + index)]));
  const publicRunner = createProtectedOfficeSetPublicHttpsScenarioRunner({
    planSnapshot: snapshot,
    client: { async runConcurrentOffice(input) {
      assert.equal(input.publicOrigin, "https://10.64.0.20/");
      return {
        transport: "authenticated-public-https", jobIds: jobs,
        assistantRunId: uuid(597), realtimeSessionId: uuid(598), ordinaryConflictingJobId: uuid(599),
        ordinaryConflictObservedQueued: true, ordinaryConflictCleanupStatus: "cancelled",
      };
    } },
  });
  const publicResult = await publicRunner.runConcurrentOffice({ ...base, publicOrigin: "https://10.64.0.20/" });
  assert.deepEqual(publicResult.jobIds, jobs);
  await assert.rejects(publicRunner.runConcurrentOffice({ ...base, publicOrigin: "http://10.64.0.20/" }),
    /public HTTPS/);

  const workerIds = snapshot.plan.set.profiles.map((profile) => profile.workerId).sort();
  const provider = createProtectedOfficeSetMaintenanceContextProvider({
    planSnapshot: snapshot,
    allocator: { async create(input) { return {
      transactionId: uuid(600), journalRevision: 8, workerIds: input.workerIds,
      allowedOperations: ["protected-set.maintenance"],
      maintenanceGeneration: input.maintenanceGeneration,
      issuedAt: "2026-09-05T12:00:00.000Z", expiresAt: "2026-09-05T12:10:00.000Z",
    }; } },
  });
  const maintenance = await provider.create({
    runId: base.runId, action: "bounded-maintenance", actionId: ACTION,
    idempotencyKey: IDEMPOTENCY, purpose: "test", operation: "protected-set.maintenance",
    workerIds, maintenanceGeneration: 7,
  });
  assert.equal(maintenance.journalRevision, 8);
  assert.equal(Object.hasOwn(maintenance, "signature"), false);
  assert.deepEqual(maintenance.workerIds, [...maintenance.workerIds].sort());

  const fault = createProtectedOfficeSetFaultController({
    planSnapshot: snapshot,
    controller: { async executeMidSequenceFailure() { return {
      observedFailureCode: "protected_set_transition_stage_failed",
      failedTransactionId: uuid(601), failedJournalRevision: 9, oomKilled: false,
    }; } },
  });
  assert.equal((await fault.executeMidSequenceFailure({ ...base, nodeAgentRuntime: {}, coordinator: {} })).oomKilled, false);

  const lifecycle = createProtectedOfficeSetPlatformLifecycleController({
    planSnapshot: snapshot,
    client: {
      async inspect() { return { phase: "ready" }; },
      async beginPlatformRestart() { return { phase: "complete" }; },
      async recoverPlatformRestart() { return { phase: "complete" }; },
    },
  });
  const lifecycleRequest = { runId: base.runId, actionId: ACTION, idempotencyKey: IDEMPOTENCY };
  assert.equal((await lifecycle.inspect(lifecycleRequest)).phase, "ready");
  await assert.rejects(lifecycle.beginPlatformRestart(lifecycleRequest), /without a real Platform disconnect/);

  const stillRestarting = createProtectedOfficeSetPlatformLifecycleController({
    planSnapshot: snapshot,
    client: {
      async inspect() { return { phase: "restart-requested" }; },
      async beginPlatformRestart() { throw new Error("not invoked"); },
      async recoverPlatformRestart() { return { phase: "restart-requested" }; },
    },
  });
  assert.equal((await stillRestarting.inspect(lifecycleRequest)).phase, "restart-requested");
  assert.equal((await stillRestarting.recoverPlatformRestart(lifecycleRequest)).phase, "restart-requested");
});

test("environment factory integrates the external maintenance signer and exposes runtime service keys", async (t) => {
  const files = await fixture(t);
  let signerClosed = 0;
  const adapters = productionAdapters(files);
  const validatorRunner = {
    async runStrictValidator(input) {
      return { status: "passed", exitCode: 0, validatorPath: input.validatorPath, evidencePath: input.evidencePath };
    },
  };
  const result = await createProtectedOfficeSetProductionWiringFromEnvironment({
    PLATFORM_PROTECTED_OFFICE_SET_REPOSITORY_ROOT: files.root,
    PLATFORM_PROTECTED_OFFICE_SET_DEPLOYMENT_PLAN_FILE: files.planFile,
    PLATFORM_PROTECTED_OFFICE_SET_NODE_ID: NODE,
    PLATFORM_PROTECTED_OFFICE_SET_NODE_GENERATION: "4",
  }, {
    ...adapters,
    validatorRunner,
    publicHttpsScenarioClient: { async runConcurrentOffice() { throw new Error("not invoked"); } },
    maintenanceContextAllocator: { async create() { throw new Error("not invoked"); } },
    platformLifecycleClient: {
      async inspect() { throw new Error("not invoked"); },
      async beginPlatformRestart() { throw new Error("not invoked"); },
      async recoverPlatformRestart() { throw new Error("not invoked"); },
    },
    faultController: { async executeMidSequenceFailure() { throw new Error("not invoked"); } },
    async maintenanceSignerClientFactory() {
      return { async sign() { throw new Error("not invoked"); }, close() { signerClosed += 1; } };
    },
  });
  assert.deepEqual(Object.keys(result.services).sort(), [
    "protectedOfficeSetBindings",
    "protectedOfficeSetClose",
    "protectedOfficeSetFaultController",
    "protectedOfficeSetMaintenanceContextProvider",
    "protectedOfficeSetMaintenanceSigner",
    "protectedOfficeSetParentEvidenceVerifier",
    "protectedOfficeSetPlatformLifecycleController",
    "protectedOfficeSetPublicHttpsScenarioRunner",
  ].sort());
  await result.close();
  await result.close();
  assert.equal(signerClosed, 1);
});

test("environment factory closes signer when a mandatory production boundary is absent", async (t) => {
  const files = await fixture(t);
  let signerClosed = 0;
  await assert.rejects(createProtectedOfficeSetProductionWiringFromEnvironment({
    PLATFORM_PROTECTED_OFFICE_SET_REPOSITORY_ROOT: files.root,
    PLATFORM_PROTECTED_OFFICE_SET_DEPLOYMENT_PLAN_FILE: files.planFile,
    PLATFORM_PROTECTED_OFFICE_SET_NODE_ID: NODE,
    PLATFORM_PROTECTED_OFFICE_SET_NODE_GENERATION: "4",
  }, {
    ...productionAdapters(files),
    validatorRunner: { async runStrictValidator() { return {}; } },
    async maintenanceSignerClientFactory() {
      return { async sign() {}, close() { signerClosed += 1; } };
    },
  }), /public HTTPS production client is missing/);
  assert.equal(signerClosed, 1);
});
