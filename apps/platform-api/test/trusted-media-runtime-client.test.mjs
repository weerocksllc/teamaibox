import assert from "node:assert/strict";
import { test } from "node:test";

import { TrustedMediaCastingRuntimeClient } from "../src/casting/trusted-media-runtime-client.mjs";

const SESSION = "10000000-0000-4000-8000-000000000001";
const VIEWER = "20000000-0000-4000-8000-000000000001";
const GRANT = "30000000-0000-4000-8000-000000000001";
const TOKEN = `${"a".repeat(16)}.${"b".repeat(32)}.${"c".repeat(43)}`;
const CERT = Buffer.from(`${"-".repeat(32)}\n-----BEGIN CERTIFICATE-----\n${"A".repeat(96)}\n`);
const KEY = Buffer.from(`${"-".repeat(32)}\n-----BEGIN ${"PRIVATE KEY"}-----\n${"B".repeat(96)}\n`);

test("total deadline aborts a transport that never finishes without disclosing its request", async () => {
  let signal;
  const client = new TrustedMediaCastingRuntimeClient({ origin: "https://127.0.0.1:17443", serverName: "localhost",
    ca: CERT, cert: CERT, key: KEY, timeoutMilliseconds: 1000,
    transport: { request(input) { signal = input.signal; return new Promise(() => {}); } } });
  try {
    const before = performance.now();
    await assert.rejects(client.health({ sessionId: SESSION }), { code: "cast_media_runtime_unavailable" });
    assert.ok(performance.now() - before < 2000);
    assert.equal(signal.aborted, true);
  } finally { client.close(); }
});

function fixture() {
  const calls = [];
  const transport = { async request(value) {
    calls.push({ ...value, ca: "bound", cert: "bound", key: "bound" });
    if (value.path.endsWith("/viewer-connections")) return { status: 200, body: {
      sessionId: SESSION, viewerIdentityId: VIEWER, grantId: GRANT,
      url: "wss://10.64.0.20:7880", accessToken: TOKEN, expiresAt: "2026-09-06T10:00:30.000Z",
    } };
    if (value.path.endsWith("/health")) return { status: 200,
      body: { healthy: true, outputs: { hdmi: { healthy: true }, browser: { healthy: true } } } };
    return { status: 204, body: null };
  } };
  const client = new TrustedMediaCastingRuntimeClient({
    origin: "https://10.64.0.20:17443", serverName: "trusted-media.teamaibox.internal",
    ca: CERT, cert: CERT, key: KEY, transport,
  });
  return { client, calls, transport };
}

test("runtime client exposes the exact casting runtime surface over one mTLS transport", async () => {
  const { client, calls } = fixture();
  const privacy = { recordingAllowed: false };
  await client.startReceiver({ sessionId: SESSION, receiverName: "Team-AI-0123456789", pairingPin: "1234",
    outputSinks: ["browser"], browserStartsMuted: false,
    mediaPrivacyPolicy: privacy, expiresAt: "2026-09-06T10:10:00.000Z" });
  await client.updateReceiver({ sessionId: SESSION, outputSinks: ["browser"],
    browserStartsMuted: false, mediaPrivacyPolicy: privacy });
  const media = await client.issueViewerConnection({ sessionId: SESSION, viewerIdentityId: VIEWER,
    grantId: GRANT, audienceRevision: 2, browserInstanceId: "browser-instance-0001",
    expiresAt: "2026-09-06T10:05:00.000Z", muted: true, maximumViewers: 8,
    publisherEncodeRenditions: 1 });
  await client.disconnectViewer({ sessionId: SESSION, viewerIdentityId: VIEWER,
    reasonCode: "cast_view_revoked" });
  assert.equal((await client.health({ sessionId: SESSION })).healthy, true);
  await client.stopReceiver({ sessionId: SESSION, reasonCode: "cast_stopped_by_initiator" });

  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    "POST /internal/v1/runtime/sessions",
    `PATCH /internal/v1/runtime/sessions/${SESSION}`,
    `POST /internal/v1/runtime/sessions/${SESSION}/viewer-connections`,
    `DELETE /internal/v1/runtime/sessions/${SESSION}/viewers/${VIEWER}`,
    `GET /internal/v1/runtime/sessions/${SESSION}/health`,
    `DELETE /internal/v1/runtime/sessions/${SESSION}`,
  ]);
  assert.deepEqual(calls[0].body.outputSinks, ["browser"]);
  assert.equal(calls[0].body.pairingPin, "1234");
  assert.equal(media.accessToken, TOKEN);
  assert.ok(calls.every((call) => call.origin === "https://10.64.0.20:17443"
    && call.serverName === "trusted-media.teamaibox.internal"
    && call.timeoutMilliseconds === (call.path.endsWith("/health") ? 3000 : 10000) && call.ca === "bound" && call.cert === "bound" && call.key === "bound"));
  client.close();
  await assert.rejects(client.health({ sessionId: SESSION }), (error) => error.code === "cast_media_runtime_unavailable");
});

test("runtime serializes SessionService Date expiry without relaxing the wire contract", async () => {
  const {client,calls} = fixture();
  const base={sessionId:SESSION,receiverName:"Team-AI-0123456789",pairingPin:"1234",outputSinks:["browser"],
    browserStartsMuted:false,mediaPrivacyPolicy:{recordingAllowed:false}};
  await client.startReceiver({...base,expiresAt:new Date("2026-09-08T10:00:00.000Z")});
  assert.equal(calls[0].body.expiresAt,"2026-09-08T10:00:00.000Z");
  for(const expiresAt of [new Date(NaN),0,{}, {toISOString:()=>"2026-09-08T10:00:00.000Z"}]) {
    await assert.rejects(client.startReceiver({...base,expiresAt}),/expiry is invalid/);
  }
  client.close();
});

test("browser-scoped disconnect carries only its scope and requires confirmed remaining connections", async () => {
  const f=fixture(),request={sessionId:SESSION,viewerIdentityId:VIEWER,
    browserInstanceId:"browser-instance-0001",reasonCode:"cast_viewer_left"};
  try {
    f.transport.request=async value=>{f.calls.push(value);return {status:200,body:{remainingBrowserConnections:2}};};
    assert.deepEqual(await f.client.disconnectViewer(request),{remainingBrowserConnections:2});
    assert.deepEqual(f.calls[0].body,request);
    for(const body of [null,{}, {remainingBrowserConnections:-1},{remainingBrowserConnections:1.5},
      {remainingBrowserConnections:true}]) {
      f.transport.request=async()=>({status:200,body});
      await assert.rejects(f.client.disconnectViewer(request),{code:"cast_media_runtime_unavailable"});
    }
    await assert.rejects(f.client.disconnectViewer({...request,browserInstanceId:null}),/browser context is invalid/);
  } finally {f.client.close();}
});

test("runtime client rejects public/plaintext endpoints and widened viewer privileges", async () => {
  const base = { serverName: "trusted-media.teamaibox.internal", ca: CERT, cert: CERT, key: KEY,
    transport: { request: async () => ({ status: 204, body: null }) } };
  for (const origin of ["http://10.64.0.20:17443", "https://8.8.8.8:17443", "https://user@10.64.0.20:17443"]) {
    assert.throws(() => new TrustedMediaCastingRuntimeClient({ ...base, origin }), /origin is invalid/);
  }
  const { client } = fixture();
  for (const pairingPin of [undefined, "123456", "0000", "123", 1234, "1234\n"]) {
    await assert.rejects(client.startReceiver({ sessionId: SESSION, receiverName: "Team-AI-0123456789",
      pairingPin, outputSinks: ["browser"], browserStartsMuted: false,
      mediaPrivacyPolicy: {}, expiresAt: "2026-09-06T10:10:00.000Z" }), /receiver start request is invalid/);
  }
  await assert.rejects(client.issueViewerConnection({ sessionId: SESSION, viewerIdentityId: VIEWER,
    grantId: GRANT, audienceRevision: 1, browserInstanceId: "browser-instance-0001",
    expiresAt: "2026-09-06T10:05:00.000Z", muted: false, maximumViewers: -1,
    publisherEncodeRenditions: 1 }), /viewer connection request is invalid/);
});

test("runtime client maps remote bodies and transport failures to one secret-free availability error", async () => {
  const current = fixture();
  current.transport.request = async () => ({ status: 500, body: { message: "secret remote detail" } });
  await assert.rejects(current.client.health({ sessionId: SESSION }), (error) =>
    error.code === "cast_media_runtime_unavailable" && !error.message.includes("secret"));
});

test("a restarted runtime's explicit missing session ends stale casting, not a transient outage", async () => {
  const { client, transport } = fixture();
  try {
    transport.request = async () => ({ status: 404,
      body: { error: { code: "cast_runtime_session_not_found" } } });
    assert.deepEqual(await client.health({ sessionId: SESSION }), {
      healthy: false, outputs: { browser: { healthy: false } },
      receiverState: "failed", failureCode: "cast_runtime_session_not_found",
    });
    // Only the authenticated health reply can prove loss of this session.
    // A missing route, service outage, bad reply or timeout cannot do so.
    for (const response of [
      { status: 404, body: { error: { code: "cast_runtime_route_not_found" } } },
      { status: 503, body: { error: { code: "cast_runtime_session_not_found" } } },
      { status: 404, body: null },
      { status: 404, body: { error: { code: "cast_runtime_session_not_found", detail: "private" } } },
    ]) {
      transport.request = async () => response;
      await assert.rejects(client.health({ sessionId: SESSION }), { code: "cast_media_runtime_unavailable" });
    }
    transport.request = async () => { throw new Error("connection reset"); };
    await assert.rejects(client.health({ sessionId: SESSION }), { code: "cast_media_runtime_unavailable" });
    transport.request = async () => ({ status: 404,
      body: { error: { code: "cast_runtime_session_not_found" } } });
    await assert.rejects(client.stopReceiver({ sessionId: SESSION, reasonCode: "cast_receiver_terminated" }),
      { code: "cast_media_runtime_unavailable" });
  } finally { client.close(); }
});

test("readiness uses authenticated transport and rejects stale, mismatched or secret-bearing replies", async () => {
  const { client, transport } = fixture();
  const value = () => ({ nodeId: SESSION, nodeGeneration: 2, observedAt: new Date().toISOString(),
    outputs: { browser: { available: true, reasonCode: null } } });
  const request = { nodeId: SESSION, nodeGeneration: 2 };
  transport.request = async args => {
    assert.equal(args.path, "/internal/v1/runtime/readiness");
    assert.equal(args.method, "GET"); assert.equal(args.body, null);
    return { status: 200, body: value() };
  };
  assert.equal((await client.readiness(request)).outputs.browser.available, true);
  for (const change of [v => ({ ...v, nodeId: VIEWER }), v => ({ ...v, nodeGeneration: 1 }),
    v => ({ ...v, observedAt: new Date(Date.now()-30_000).toISOString() }), v => ({ ...v, secret: "not allowed" }),
    v => ({ ...v, outputs: { ...v.outputs, hdmi: { available: true, reasonCode: "cast_hdmi_display_busy" } } })]) {
    transport.request = async () => ({ status: 200, body: change(value()) });
    await assert.rejects(client.readiness(request), e => e.code === "cast_media_runtime_unavailable");
  }
});

test("one-use media admission forwards only independently authenticated context over mTLS", async () => {
  const { client, transport, calls } = fixture();
  transport.request = async value => {
    calls.push(value);
    return { status: 200, body: { sessionId: SESSION, viewerIdentityId: VIEWER,
      grantId: GRANT, participantIdentity: "cast-" + "a".repeat(32) } };
  };
  const consumed = await client.consumeViewerConnection({ sessionId: SESSION, viewerIdentityId: VIEWER,
    browserInstanceId: "browser-instance-0001", accessToken: TOKEN });
  assert.equal(calls[0].path, `/internal/v1/runtime/sessions/${SESSION}/viewer-connections/consume`);
  assert.equal(calls[0].body.accessToken, TOKEN);
  assert.equal(consumed.grantId, GRANT);
  assert.equal("accessToken" in consumed, false);
  transport.request = async () => ({ status: 200, body: { ...consumed, viewerIdentityId: GRANT } });
  await assert.rejects(client.consumeViewerConnection({ sessionId: SESSION, viewerIdentityId: VIEWER,
    browserInstanceId: "browser-instance-0001", accessToken: TOKEN }), error => error.code === "cast_media_runtime_unavailable");
});
