import assert from "node:assert/strict";
import test from "node:test";

import {
  ComputeCapabilityRegistrationError,
  ComputeCapabilityRegistrationService,
} from "../src/compute-capability-registration-service.mjs";
import { MemoryPluginAccessRepository } from "../src/memory-plugin-access-repository.mjs";

const workerId = "00000000-0000-4000-8000-000000000901";
const nodeId = "00000000-0000-4000-8000-000000000902";
const leaseId = "00000000-0000-4000-8000-000000000903";
const profileId = "00000000-0000-4000-8000-000000000904";
const capabilityId = "00000000-0000-4000-8000-000000000905";
const pluginId = "example.fast-ocr";
const fixedNow = new Date("2026-08-11T03:00:00.000Z");

function verifiedAuthority(overrides = {}) {
  return { workerId, nodeId, leaseId, fencingToken: 7, workerGeneration: 3, ...overrides };
}

function fixture({ authorityFacts = {} } = {}) {
  const repository = new MemoryPluginAccessRepository();
  repository.seedPlugin({
    pluginId,
    pluginType: "ComputePlugin",
    lifecycleState: "enabled",
    currentVersion: "2.0.0",
    generation: 5,
    manifest: { permissions: { delegatedUserToken: false, platformApiScopes: ["compute:report"] } },
  });
  repository.seedWorker({
    workerId,
    pluginId,
    nodeId,
    modelProfileId: profileId,
    generation: 3,
    controlLeaseId: leaseId,
    controlFencingToken: 7,
    lifecycleState: "ready",
    healthState: "healthy",
  });
  repository.seedProfile({
    modelProfileId: profileId,
    capabilityId,
    capabilityKey: "ocr.document",
    modality: "ocr",
    certificationState: "certified",
    operations: ["ocr"],
    resourceEnvelope: {
      cpuMillis: 2000,
      unifiedMemoryBytes: 8589934592,
      storageBytes: 1073741824,
      networkBitsPerSecond: 100000000,
      acceleratorUnits: 1,
      codecSessions: 0,
    },
  });
  const audits = [];
  const service = new ComputeCapabilityRegistrationService({
    repository,
    schedulerAuthority: {
      async verify(authority, request) {
        if (authority !== "scheduler-mtls-boundary") throw new Error("scheduler authority rejected");
        if (request.operation === "list-compute-capabilities") return { scheduler: true };
        return verifiedAuthority(authorityFacts);
      },
    },
    auditSink: { async record(event) { audits.push(event); } },
    clock: () => fixedNow,
  });
  return { repository, service, audits };
}

const claims = () => [{ modelProfileId: profileId, operations: ["ocr"] }];

test("verified scheduler registers only a certified worker-assigned logical capability", async () => {
  const { service, audits } = fixture();
  const records = await service.register({ authority: "scheduler-mtls-boundary", pluginId, claims: claims() });
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    registrationId: records[0].registrationId,
    pluginId,
    pluginVersion: "2.0.0",
    pluginGeneration: 5,
    workerId,
    workerGeneration: 3,
    nodeId,
    modelProfileId: profileId,
    capabilityId,
    capabilityKey: "ocr.document",
    modality: "ocr",
    operations: ["ocr"],
    resourceEnvelope: {
      cpuMillis: 2000,
      unifiedMemoryBytes: 8589934592,
      storageBytes: 1073741824,
      networkBitsPerSecond: 100000000,
      acceleratorUnits: 1,
      codecSessions: 0,
    },
    expiresAt: "2026-08-11T03:01:30.000Z",
  });
  assert.equal((await service.listForScheduler({ authority: "scheduler-mtls-boundary" })).length, 1);
  assert.equal(audits[0].action, "plugin.compute_capabilities.registered");
});

test("plugin-originated registration and user tokens cannot bypass the scheduler authority boundary", async () => {
  const { service } = fixture();
  for (const authority of [null, { kind: "ComputePlugin" }, "taibp_v1_user-token"]) {
    await assert.rejects(
      service.register({ authority, pluginId, claims: claims() }),
      (error) => error.code === "compute_registration_scheduler_required",
    );
  }
  await assert.rejects(
    service.listForScheduler({ authority: { kind: "ComputePlugin" } }),
    (error) => error.code === "compute_registration_scheduler_required",
  );
});

test("stale fence, wrong profile, unhealthy worker, and uncertified operations fail closed", async () => {
  const { repository, service } = fixture();
  const stale = await repository.getWorker(workerId);
  stale.controlFencingToken = 8;
  repository.seedWorker(stale);
  await assert.rejects(
    service.register({ authority: "scheduler-mtls-boundary", pluginId, claims: claims() }),
    (error) => error.code === "compute_registration_worker_fenced",
  );
  stale.controlFencingToken = 7;
  repository.seedWorker(stale);
  await assert.rejects(
    service.register({ authority: "scheduler-mtls-boundary", pluginId, claims: [{ modelProfileId: capabilityId, operations: ["ocr"] }] }),
    (error) => error.code === "compute_registration_profile_denied",
  );
  const profile = (await repository.getProfiles([profileId]))[0];
  profile.certificationState = "benchmark";
  repository.seedProfile(profile);
  await assert.rejects(
    service.register({ authority: "scheduler-mtls-boundary", pluginId, claims: claims() }),
    (error) => error.code === "compute_registration_profile_uncertified",
  );
});

test("an Experimental worker registration requires an exact signed non-production scheduler policy", async () => {
  const denied = fixture();
  const profile = (await denied.repository.getProfiles([profileId]))[0];
  profile.certificationState = "experimental";
  denied.repository.seedProfile(profile);
  await assert.rejects(
    denied.service.register({ authority: "scheduler-mtls-boundary", pluginId, claims: claims() }),
    (error) => error.code === "compute_registration_profile_uncertified",
  );

  const production = fixture({ authorityFacts: { routingEnvironment: "production", experimentalProfileIds: [profileId] } });
  const productionProfile = (await production.repository.getProfiles([profileId]))[0];
  productionProfile.certificationState = "experimental";
  production.repository.seedProfile(productionProfile);
  await assert.rejects(
    production.service.register({ authority: "scheduler-mtls-boundary", pluginId, claims: claims() }),
    (error) => error.code === "compute_registration_profile_uncertified",
  );

  const allowed = fixture({ authorityFacts: { routingEnvironment: "validation", experimentalProfileIds: [profileId] } });
  const allowedProfile = (await allowed.repository.getProfiles([profileId]))[0];
  allowedProfile.certificationState = "experimental";
  allowed.repository.seedProfile(allowedProfile);
  assert.equal((await allowed.service.register({
    authority: "scheduler-mtls-boundary", pluginId, claims: claims(),
  })).length, 1);
});

test("registration is immutable per worker generation and retirement removes scheduler visibility", async () => {
  const { repository, service } = fixture();
  const first = await service.register({ authority: "scheduler-mtls-boundary", pluginId, claims: claims() });
  const replay = await service.register({ authority: "scheduler-mtls-boundary", pluginId, claims: claims() });
  assert.equal(replay[0].registrationId, first[0].registrationId);
  const profile = (await repository.getProfiles([profileId]))[0];
  profile.operations = ["ocr", "responses"];
  repository.seedProfile(profile);
  await assert.rejects(
    service.register({ authority: "scheduler-mtls-boundary", pluginId, claims: [{ modelProfileId: profileId, operations: ["ocr", "responses"] }] }),
    (error) => error.code === "compute_registration_conflict",
  );
  assert.equal((await service.retireWorker({
    authority: "scheduler-mtls-boundary",
    workerId,
    workerGeneration: 3,
  })).count, 1);
  assert.deepEqual(await service.listForScheduler({ authority: "scheduler-mtls-boundary" }), []);
});

test("registration claims cannot include endpoints, user identities, tokens, or physical routing", async () => {
  const { service } = fixture();
  for (const extra of ["endpoint", "userToken", "nodeId", "gpuId"]) {
    const claim = claims()[0];
    claim[extra] = "forbidden";
    await assert.rejects(
      service.register({ authority: "scheduler-mtls-boundary", pluginId, claims: [claim] }),
      ComputeCapabilityRegistrationError,
    );
  }
});
