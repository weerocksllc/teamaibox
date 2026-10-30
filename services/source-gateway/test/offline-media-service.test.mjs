import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import { MemoryOfflineMediaRepository } from "../src/memory-offline-media-repository.mjs";
import { OfflineMediaService } from "../src/offline-media-service.mjs";
import { StaticOfflineMediaInventory } from "../src/static-offline-media-inventory.mjs";
import { reserveBufferedMedia } from "../../object-service/src/buffered-media-budget.mjs";

const ADMIN = "018f6f18-24d7-7c21-9b62-8c017419958b";
const NODE = "018f6f18-24d7-7c21-9b62-8c017419959b";
const MEDIA = "018f6f18-24d7-7c21-9b62-8c0174199501";
const FS = "018f6f18-24d7-7c21-9b62-8c0174199502";
const DEVICE = `sha256:${"1".repeat(64)}`;
const KEY = "A".repeat(40);
const manager = { identityId: ADMIN, permissions: ["source:view", "source:manage"] };
const viewer = { identityId: ADMIN, permissions: ["source:view"] };

test("fleet inventory and discovery keep all 140 attached media", async () => {
  const media=Array.from({length:140},(_,i)=>({nodeId:NODE,mountId:randomUUID(),filesystemUuid:randomUUID(),deviceIdentitySha256:sha(Buffer.from(String(i))),
    filesystemType:'ext4',transport:'usb',volumeLabel:`FIXTURE-${i}`,capacityBytes:1024,readOnly:true,mountMode:'read-only'}));
  const inventory=new StaticOfflineMediaInventory({media});const attached=await inventory.listReadOnlyMedia({nodeId:NODE});assert.equal(attached.length,140);
  const service=new OfflineMediaService({repository:new MemoryOfflineMediaRepository(),discovery:{listAttached:async()=>attached.map((row,i)=>({...row,present:true,mediaHandle:`fixture.${i}`,manifestSha256:DEVICE}))},
    inspector:{readManifest:async()=>{throw Error('not approving')},verifyManifest:async()=>{},verifyArtifact:async()=>{}}});
  assert.equal((await service.discover({context:manager,nodeId:NODE})).data.length,140);
  await assert.rejects(service.discover({context:viewer,nodeId:NODE}),{code:'source_permission_required'});
});

test("large manifests are admitted by available memory instead of a 16 MiB byte ceiling", async () => {
  const bytes=Buffer.concat([manifest(),Buffer.alloc(17*1024*1024,0x20)]);
  const f=fixture({manifestBytes:bytes});await f.service.discover({context:manager,nodeId:NODE});
  const approved=await f.service.approve({context:manager,mediaId:MEDIA,expectedRevision:1,expectedManifestSha256:f.manifestSha256});
  assert.equal(approved.inventory.artifactCount,3);
});

test("offline media indexes more than 100000 artifacts without truncating", async () => {
  const item=JSON.parse(manifest()).artifacts[1];const count=100001;
  const bytes=manifest({artifacts:Array.from({length:count},(_,i)=>({...item,name:`package-${i}`,relativePath:`pip/package-${i}.whl`}))});
  const f=fixture({manifestBytes:bytes});await f.service.discover({context:manager,nodeId:NODE});
  const approved=await f.service.approve({context:manager,mediaId:MEDIA,expectedRevision:1,expectedManifestSha256:f.manifestSha256});
  assert.equal(approved.inventory.artifactCount,count);assert.equal((await f.service.artifacts({context:viewer,mediaId:MEDIA})).data.length,count);
});

function sha(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function manifest(overrides = {}) {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1, mediaKey: "team-offline-2026-08", signature: { detachedPath: "manifest.json.asc", keyFingerprint: KEY },
    artifacts: [
      { ecosystem: "pip", name: "agent-tools", version: "1.0.0", relativePath: "pip/agent_tools-1.0.0.whl", architecture: "arm64", sizeBytes: 100, sha256: `sha256:${"a".repeat(64)}`, dependencies: [{ name: "team-common", constraint: ">=1", optional: false }], signature: { required: false } },
      { ecosystem: "pip", name: "team-common", version: "1.2.0", relativePath: "pip/team_common-1.2.0.whl", architecture: "all", sizeBytes: 50, sha256: `sha256:${"b".repeat(64)}`, dependencies: [], signature: { required: false } },
      { ecosystem: "apt", name: "ffmpeg", version: "7.0-1", relativePath: "apt/ffmpeg_7.0-1_arm64.deb", architecture: "arm64", sizeBytes: 200, sha256: `sha256:${"c".repeat(64)}`, dependencies: [{ name: "libcodec", constraint: ">=7", optional: false }], signature: { required: true, detachedPath: "apt/ffmpeg.deb.asc", keyFingerprint: KEY } },
    ],
    ...overrides,
  }));
}

function fixture({ manifestBytes = manifest(), corruptPath = null, availableMemory = 1024**3 } = {}) {
  const attached = { current: true };
  const audit = [];
  const discovery = { calls: 0 };
  const inspector = {
    async readManifest() { return manifestBytes; },
    async verifyManifest() { return { status: "verified", keyFingerprint: KEY, signedSha256: sha(manifestBytes) }; },
    async verifyArtifact({ relativePath, expectedSha256, expectedBytes, expectedKeyFingerprint }) {
      return { actualSha256: relativePath === corruptPath ? `sha256:${"f".repeat(64)}` : expectedSha256, actualBytes: expectedBytes, integrity: "verified", signatureStatus: expectedKeyFingerprint ? "verified" : "manifest-covered", keyFingerprint: expectedKeyFingerprint };
    },
  };
  const service = new OfflineMediaService({
    // Deterministic memory capacity, independent of other apps on the test host.
    admitManifestMemory: size => reserveBufferedMedia(size,{available:()=>availableMemory,heap:()=>availableMemory}),
    repository: new MemoryOfflineMediaRepository(),
    discovery: { async listAttached() { discovery.calls += 1; return attached.current ? [{ present: true, readOnly: true, mountMode: "read-only", deviceIdentitySha256: DEVICE,
      filesystemUuid: FS, manifestSha256: sha(manifestBytes), mediaHandle: `offline-media.team-2026.${discovery.calls}`, filesystemType: "ext4", transport: "usb", volumeLabel: "TEAM-AI-OFFLINE", capacityBytes: 4_000_000_000_000 }] : []; } },
    inspector, idFactory: () => MEDIA, clock: (() => { let tick = 0; return () => new Date(`2026-08-11T10:00:0${tick++}.000Z`); })(), audit: async (event) => audit.push(event),
  });
  return { service, attached, discovery, audit, manifestSha256: sha(manifestBytes) };
}

test("administrator discovers read-only media, approves verified artifacts, and receives dependency inventory", async () => {
  const f = fixture();
  const discovered = await f.service.discover({ context: manager, nodeId: NODE });
  assert.equal(discovered.data[0].approvalState, "pending");
  assert.equal(discovered.data[0].availability, "attached");
  const approved = await f.service.approve({ context: manager, mediaId: MEDIA, expectedRevision: 1, expectedManifestSha256: f.manifestSha256 });
  assert.equal(f.discovery.calls, 2);
  assert.equal(approved.approvalState, "approved");
  assert.equal(approved.lifecycleState, "ready");
  assert.equal(approved.health.state, "degraded");
  assert.equal(approved.inventory.artifactCount, 3);
  assert.equal(approved.inventory.ecosystems.pip.packages, 2);
  assert.deepEqual(approved.inventory.architectures, ["all", "arm64"]);
  assert.deepEqual(approved.inventory.missingDependencies, [{ ecosystem: "apt", package: "ffmpeg", version: "7.0-1", dependency: "libcodec", constraint: ">=7" }]);
  const artifacts = await f.service.artifacts({ context: viewer, mediaId: MEDIA });
  assert.equal(artifacts.data[2].signatureStatus, "verified");
  assert.equal(JSON.stringify(artifacts).includes("mediaHandle"), false);
  assert.deepEqual(f.audit.map((item) => item.action), ["source_center.offline_media_discovered", "source_center.offline_media_approved"]);
});

test("approval fails closed against live attachment state instead of trusting a persisted runtime handle", async () => {
  const f = fixture();
  await f.service.discover({ context: manager, nodeId: NODE });
  f.attached.current = false;
  await assert.rejects(f.service.approve({ context: manager, mediaId: MEDIA, expectedRevision: 1, expectedManifestSha256: f.manifestSha256 }), { code: "offline_media_detached", status: 409 });
});

test("disk removal immediately detaches approved inventory and reattachment requires reapproval", async () => {
  const f = fixture();
  await f.service.discover({ context: manager, nodeId: NODE });
  await f.service.approve({ context: manager, mediaId: MEDIA, expectedRevision: 1, expectedManifestSha256: f.manifestSha256 });
  f.attached.current = false;
  const removed = await f.service.discover({ context: manager, nodeId: NODE });
  assert.equal(removed.data[0].availability, "detached");
  assert.equal(removed.data[0].health.errorCode, "offline_media_removed");
  f.attached.current = true;
  const returned = await f.service.discover({ context: manager, nodeId: NODE });
  assert.equal(returned.data[0].availability, "attached");
  assert.equal(returned.data[0].approvalState, "pending");
  assert.equal(returned.data[0].lifecycleState, "discovered");
});

test("approval rejects changed manifests, corrupted artifacts, unsupported architecture, and non-admin mutation", async () => {
  const corrupt = fixture({ corruptPath: "pip/agent_tools-1.0.0.whl" });
  await corrupt.service.discover({ context: manager, nodeId: NODE });
  await assert.rejects(corrupt.service.approve({ context: manager, mediaId: MEDIA, expectedRevision: 1, expectedManifestSha256: corrupt.manifestSha256 }), { code: "offline_media_artifact_invalid" });
  await assert.rejects(corrupt.service.approve({ context: manager, mediaId: MEDIA, expectedRevision: 1, expectedManifestSha256: `sha256:${"0".repeat(64)}` }), { code: "offline_media_manifest_changed" });
  await assert.rejects(corrupt.service.discover({ context: viewer, nodeId: NODE }), { code: "source_permission_required" });

  const amd64 = fixture({ manifestBytes: manifest({ artifacts: [{ ecosystem: "npm", name: "native-addon", version: "1.0.0", relativePath: "npm/native.tgz", architecture: "amd64", sizeBytes: 20, sha256: `sha256:${"d".repeat(64)}`, dependencies: [], signature: { required: false } }] }) });
  await amd64.service.discover({ context: manager, nodeId: NODE });
  await assert.rejects(amd64.service.approve({ context: manager, mediaId: MEDIA, expectedRevision: 1, expectedManifestSha256: amd64.manifestSha256 }), { code: "offline_media_architecture_unsupported" });
});
