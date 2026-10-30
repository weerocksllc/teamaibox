import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";

import { MemoryBlobStore } from "../../../services/object-service/src/memory-blob-store.mjs";
import { MemoryObjectRepository } from "../../../services/object-service/src/memory-repository.mjs";
import { ProtectedObjectService } from "../../../services/object-service/src/object-service.mjs";
import { ObjectHttpApi } from "../src/objects/object-http-api.mjs";

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function fixture() {
  const service = new ProtectedObjectService({
    repository: new MemoryObjectRepository(),
    blobStore: new MemoryBlobStore(),
    referenceSigningKey: randomBytes(32),
    allowTestPlaintextBlobStore: true,
  });
  return {
    api: new ObjectHttpApi({ service }),
    context: {
      identityId: "11111111-1111-4111-8111-111111111111",
      identity: { identityKind: "local_user" },
      permissions: ["file:read", "file:write", "ai:invoke"],
    },
  };
}

test("downloads retain real Unicode filenames without leaking paths or injecting headers", async () => {
  const { api, context } = fixture();
  for (const name of ['report.txt', '会议纪要 你好.png', '财务"草稿" (1) 🎉.txt']) {
    const content = Buffer.from("download bytes");
    const uploaded = await api.handle({
      method: "POST", pathname: "/api/v1/objects/uploads", body: content, context,
      headers: { "content-type": "text/plain", "x-content-sha256": sha256(content), "x-teamaibox-object-name": encodeURIComponent(name) },
      query: new URLSearchParams("capability=assistant.input"),
    });
    const pathname = `/api/v1/objects/references/${uploaded.body.reference_id}/content`;
    let disposition;
    for (const method of ["GET", "HEAD"]) {
      const result = await api.handle({ method, pathname, context, query: new URLSearchParams("download=1") });
      const header = result.headers["content-disposition"];
      assert.match(header, /^attachment; filename="[^"\\\r\n]+"; filename\*=UTF-8''/);
      assert.equal(decodeURIComponent(header.split("filename*=UTF-8''")[1]), name);
      assert.equal(header.includes("ai-inputs/"), false);
      if (disposition) assert.equal(header, disposition);
      disposition = header;
    }
    const inline = await api.handle({ method: "GET", pathname, context });
    assert.equal(inline.headers["content-disposition"], undefined);
    await assert.rejects(api.handle({ method: "GET", pathname, context: { ...context, identityId: "22222222-2222-4222-8222-222222222222" }, query: new URLSearchParams("download=1") }));
  }
});

test('phone multipart uses a bounded owner namespace and a short-lived file audience', async () => {
  const {api,context}=fixture(),content=Buffer.from('synthetic phone APK bytes'),digest=sha256(content);
  const body={capability:'virtual_phone',name:'办公.apk',media_type:'application/octet-stream',size:content.length,sha256:digest};
  for(const size of [0,1.5])await assert.rejects(api.handle({method:'POST',pathname:'/api/v1/objects/multipart',context,body:{...body,size}}));
  const started=await api.handle({method:'POST',pathname:'/api/v1/objects/multipart',context,body});
  const uploadId=started.body.upload.uploadId,uploadPath='/api/v1/objects/multipart/'+uploadId;
  const other={...context,identityId:'22222222-2222-4222-8222-222222222222'};
  await assert.rejects(api.handle({method:'PUT',pathname:uploadPath+'/parts/1',context:other,body:content,headers:{'x-content-sha256':digest}}));
  await api.handle({method:'PUT',pathname:uploadPath+'/parts/1',context,body:content,headers:{'x-content-sha256':digest}});
  const done=await api.handle({method:'POST',pathname:uploadPath,context,body:{parts:[{part_number:1,sha256:digest}]}});
  assert.equal(done.status,201);assert.match(done.body.object.objectKey,/^virtual-phones\/inputs\/[^/]+\/办公.apk$/);
  assert.equal(done.body.object.namespaceKey,'user:'+context.identityId);
  assert.equal(done.body.object.integrity.digest,digest);
  const referencePath='/api/v1/objects/references/'+done.body.reference_id+'/content';
  assert.deepEqual((await api.handle({method:'GET',pathname:referencePath,context})).body,content);
  await assert.rejects(api.handle({method:'GET',pathname:referencePath,context:other}));
  assert.ok(Date.parse(done.body.reference_expires_at)-Date.now()<=900000);
});

test("uploads verified bytes and returns only a short-lived scoped compute reference", async () => {
  const { api, context } = fixture();
  const content = Buffer.from("encrypted object adapter");
  const uploaded = await api.handle({
    method: "POST",
    pathname: "/api/v1/objects/uploads",
    body: content,
    context,
    headers: {
      "content-type": "image/png",
      "x-content-sha256": sha256(content),
      "x-teamaibox-object-name": encodeURIComponent("扫描 件.png"),
    },
    query: new URLSearchParams("capability=ocr"),
  });
  assert.equal(uploaded.status, 201);
  assert.match(uploaded.body.reference_id, /^[0-9a-f-]{36}$/);
  assert.equal(JSON.stringify(uploaded.body).includes("token"), false);
  assert.equal(uploaded.body.object.contentType, "image/png");
  assert.match(uploaded.body.object.objectKey, /\/扫描 件\.png$/);

  const contentResult = await api.handle({
    method: "GET",
    pathname: `/api/v1/objects/references/${uploaded.body.reference_id}/content`,
    context,
    headers: { range: "bytes=0-8" },
  });
  assert.equal(contentResult.status, 206);
  assert.equal(contentResult.body.toString(), "encrypted");
  assert.equal(contentResult.headers["content-range"], `bytes 0-8/${content.byteLength}`);

  const head = await api.handle({
    method: "HEAD",
    pathname: `/api/v1/objects/references/${uploaded.body.reference_id}/content`,
    context,
  });
  assert.equal(head.kind, "empty");
  assert.equal(head.headers["content-length"], String(content.byteLength));
});

test('all supported application uploads can use multipart and keep the correct audience',async()=>{
  for(const capability of ['ocr','asr','image','translation','messaging.attachment','assistant.input']){
    const {api,context}=fixture(),content=Buffer.from(capability),sha=sha256(content);
    const started=await api.handle({method:'POST',pathname:'/api/v1/objects/multipart',context,
      body:{capability,name:'test.bin',media_type:'application/octet-stream',size:content.length,sha256:sha}});
    const path='/api/v1/objects/multipart/'+started.body.upload.uploadId;
    await api.handle({method:'PUT',pathname:path+'/parts/1',context,body:content,headers:{'x-content-sha256':sha}});
    const done=await api.handle({method:'POST',pathname:path,context,body:{parts:[{part_number:1,sha256:sha}]}});
    assert.equal(done.status,201);assert.match(done.body.object.objectKey,new RegExp('^ai-inputs/'+capability+'/'));
    assert.deepEqual((await api.handle({method:'GET',pathname:'/api/v1/objects/references/'+done.body.reference_id+'/content',context})).body,content);
  }
});

test("lists only the caller namespace and can scope a selected object for OCR", async () => {
  const { api, context } = fixture();
  const content = Buffer.from("document");
  const uploaded = await api.handle({
    method: "POST", pathname: "/api/v1/objects/uploads", body: content, context,
    headers: {
      "content-type": "application/pdf",
      "x-content-sha256": sha256(content),
      "x-teamaibox-object-name": "report.pdf",
    },
    query: new URLSearchParams("capability=ocr"),
  });
  const listed = await api.handle({
    method: "GET", pathname: "/api/v1/objects", context,
    query: new URLSearchParams("prefix=ai-inputs/&limit=20"),
  });
  assert.equal(listed.body.data.length, 1);
  assert.equal(listed.body.data[0].objectId, uploaded.body.object.objectId);

  const selected = await api.handle({
    method: "POST",
    pathname: `/api/v1/objects/${uploaded.body.object.objectId}/references`,
    body: { capability: "ocr" },
    context,
  });
  assert.equal(selected.status, 201);
  assert.notEqual(selected.body.reference_id, uploaded.body.reference_id);
});

test("object selection accepts only a caller-shortened scoped reference lifetime", async () => {
  const { api, context } = fixture();
  const content = Buffer.from("short-lived handoff");
  const uploaded = await api.handle({
    method: "POST", pathname: "/api/v1/objects/uploads", body: content, context,
    headers: {
      "content-type": "application/octet-stream",
      "x-content-sha256": sha256(content),
      "x-teamaibox-object-name": "short-lived.bin",
    },
    query: new URLSearchParams("capability=team_drive"),
  });
  const before = Date.now();
  const selected = await api.handle({
    method: "POST",
    pathname: `/api/v1/objects/${uploaded.body.object.objectId}/references`,
    body: { capability: "team_drive", expires_in_seconds: 1 },
    context,
  });
  const lifetime = new Date(selected.body.reference_expires_at).getTime() - before;
  assert.ok(lifetime > 0 && lifetime <= 1_100);
  for (const expiresInSeconds of [0, 601, 1.5, "soon"]) {
    await assert.rejects(api.handle({
      method: "POST",
      pathname: `/api/v1/objects/${uploaded.body.object.objectId}/references`,
      body: { capability: "team_drive", expires_in_seconds: expiresInSeconds },
      context,
    }), (error) => error.code === "invalid_object_expiry" && error.status === 400);
  }
});

test("the issuer can actively revoke a scoped reference and revoked content fails closed", async () => {
  const { api, context } = fixture();
  const content = Buffer.from("temporary cross-application handoff");
  const uploaded = await api.handle({
    method: "POST", pathname: "/api/v1/objects/uploads", body: content, context,
    headers: {
      "content-type": "application/octet-stream",
      "x-content-sha256": sha256(content),
      "x-teamaibox-object-name": "handoff.bin",
    },
    query: new URLSearchParams("capability=team_drive"),
  });
  const referenceId = uploaded.body.reference_id;
  assert.equal(api.matches("DELETE", `/api/v1/objects/references/${referenceId}`), true);

  const revoked = await api.handle({
    method: "DELETE",
    pathname: `/api/v1/objects/references/${referenceId}`,
    context,
  });
  assert.equal(revoked.status, 200);
  assert.deepEqual(Object.keys(revoked.body).sort(), ["referenceId", "revoked", "revokedAt"]);
  assert.equal(revoked.body.referenceId, referenceId);
  assert.equal(revoked.body.revoked, true);

  await assert.rejects(api.handle({
    method: "GET",
    pathname: `/api/v1/objects/references/${referenceId}/content`,
    context,
  }), (error) => error.code === "invalid_reference" && error.status === 404);
});

test("a different local user cannot revoke another issuer's scoped reference", async () => {
  const { api, context } = fixture();
  const content = Buffer.from("private handoff");
  const uploaded = await api.handle({
    method: "POST", pathname: "/api/v1/objects/uploads", body: content, context,
    headers: {
      "content-type": "application/octet-stream",
      "x-content-sha256": sha256(content),
      "x-teamaibox-object-name": "private.bin",
    },
    query: new URLSearchParams("capability=team_drive"),
  });
  const other = { ...context, identityId: "22222222-2222-4222-8222-222222222222" };
  await assert.rejects(api.handle({
    method: "DELETE",
    pathname: `/api/v1/objects/references/${uploaded.body.reference_id}`,
    context: other,
  }), (error) => error.code === "object_access_denied" && error.status === 403);
});

test("fails closed on integrity mismatch, unknown audience, and missing file permissions", async () => {
  const { api, context } = fixture();
  const request = {
    method: "POST", pathname: "/api/v1/objects/uploads", body: Buffer.from("content"), context,
    headers: {
      "content-type": "image/png",
      "x-content-sha256": "0".repeat(64),
      "x-teamaibox-object-name": "input.png",
    },
    query: new URLSearchParams("capability=ocr"),
  };
  await assert.rejects(api.handle(request), (error) => error.code === "integrity_mismatch");
  await assert.rejects(api.handle({ ...request, headers: { ...request.headers, "x-content-sha256": sha256(request.body) }, query: new URLSearchParams("capability=shell") }), (error) => error.code === "invalid_object_audience");
  await assert.rejects(api.handle({ ...request, context: { ...context, permissions: ["file:read"] } }), (error) => error.code === "object_access_denied");
});

test("large Team Drive uploads resume verified parts and complete to a file-scoped reference", async () => {
  const { api, context } = fixture();
  const left = Buffer.from("verified ");
  const right = Buffer.from("resume");
  const content = Buffer.concat([left, right]);
  const started = await api.handle({
    method: "POST",
    pathname: "/api/v1/objects/multipart",
    body: {
      capability: "team_drive",
      name: "long recording.wav",
      media_type: "audio/wav",
      size: content.byteLength,
      sha256: sha256(content),
    },
    context,
  });
  assert.equal(started.status, 201);
  assert.equal(started.body.part_size_bytes, 16 * 1024 * 1024);
  const uploadId = started.body.upload.uploadId;

  const second = await api.handle({
    method: "PUT",
    pathname: `/api/v1/objects/multipart/${uploadId}/parts/2`,
    body: right,
    context,
    headers: { "x-content-sha256": sha256(right) },
  });
  assert.equal(second.body.part.partNumber, 2);
  const resumed = await api.handle({
    method: "GET", pathname: `/api/v1/objects/multipart/${uploadId}/parts`, context,
  });
  assert.deepEqual(resumed.body.data.map((part) => part.partNumber), [2]);
  await api.handle({
    method: "PUT",
    pathname: `/api/v1/objects/multipart/${uploadId}/parts/1`,
    body: left,
    context,
    headers: { "x-content-sha256": sha256(left) },
  });

  const completed = await api.handle({
    method: "POST",
    pathname: `/api/v1/objects/multipart/${uploadId}`,
    body: {
      parts: [
        { part_number: 1, sha256: sha256(left) },
        { part_number: 2, sha256: sha256(right) },
      ],
    },
    context,
  });
  assert.equal(completed.status, 201);
  assert.match(completed.body.reference_id, /^[0-9a-f-]{36}$/);
  assert.equal(JSON.stringify(completed.body).includes("token"), false);

  const downloaded = await api.handle({
    method: "GET",
    pathname: `/api/v1/objects/references/${completed.body.reference_id}/content`,
    context,
  });
  assert.equal(downloaded.body.toString(), content.toString());
});
