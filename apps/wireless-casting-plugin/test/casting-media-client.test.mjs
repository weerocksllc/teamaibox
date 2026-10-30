import assert from "node:assert/strict";
import { test } from "node:test";

import {
  castingMediaClientPolicyV1,
  createCastingMediaClientV1,
} from "../src/public/casting-media-client-v1.mjs";

const SESSION = "44444444-4444-4444-8444-444444444444";
const VIEWER = "22222222-2222-4222-8222-222222222222";
const GRANT = "55555555-5555-4555-8555-555555555555";
const TOKEN = `${"a".repeat(16)}.${"b".repeat(32)}.${"c".repeat(16)}`;

function connection(overrides = {}) {
  return { sessionId: SESSION, viewerIdentityId: VIEWER, grantId: GRANT,
    url: "wss://casting.test/livekit", accessToken: TOKEN,
    expiresAt: "2026-09-04T05:00:00.000Z", muted: true, ...overrides };
}

function fakeSdk() {
  const events = { TrackSubscribed: "track-subscribed", TrackUnsubscribed: "track-unsubscribed",
    Reconnecting: "reconnecting", Reconnected: "reconnected", Disconnected: "disconnected" };
  let instance = null;
  class Room {
    constructor(options) { this.options = options; this.listeners = new Map(); this.connectCalls = []; instance = this; }
    on(name, listener) { this.listeners.set(name, listener); return this; }
    emit(name, ...values) { this.listeners.get(name)?.(...values); }
    async connect(url, token, options) { this.connectCalls.push({ url, token, options }); }
    async disconnect() { this.emit(events.Disconnected); }
  }
  return { sdk: { Room, RoomEvent: events, Track: { Kind: { Video: "video", Audio: "audio" } } },
    instance: () => instance };
}

function videoElement() {
  const listeners = new Map();
  return { hidden: true, muted: false, playsInline: false, srcObject: null,
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    emit(name) { listeners.get(name)?.(); },
    playCalls: 0, pauseCalls: 0,
    async play() { this.playCalls += 1; }, pause() { this.pauseCalls += 1; } };
}

function fixture() {
  const fake = fakeSdk(), video = videoElement(), states = [];
  const client = createCastingMediaClientV1({ loadSdk: async () => fake.sdk,
    clock: () => new Date("2026-09-04T04:00:00.000Z") });
  const connect = () => client.connect({ connection: connection(), videoElement: video,
    onState: value => states.push(value) });
  const track = kind => ({ kind, attach() {}, detach() {} });
  const subscribe = item => fake.instance().emit(fake.sdk.RoomEvent.TrackSubscribed, item);
  const unsubscribe = item => fake.instance().emit(fake.sdk.RoomEvent.TrackUnsubscribed, item);
  return { fake, video, states, client, connect, track, subscribe, unsubscribe };
}

test('server disconnect reasons reach the UI without arbitrary SDK detail', async () => {
  for (const [reason, expected] of [[4, 'removed'], [3, 'ended'], [99, 'connection_lost'], [undefined, 'connection_lost']]) {
    const f = fixture();
    f.fake.sdk.DisconnectReason = { PARTICIPANT_REMOVED: 4, ROOM_DELETED: 3 };
    const observed = [];
    await f.client.connect({ connection: connection(), videoElement: f.video,
      onDisconnected: value => observed.push(value) });
    f.fake.instance().emit(f.fake.sdk.RoomEvent.Disconnected, reason);
    assert.deepEqual(observed, [expected]);
    assert.equal(f.client.isConnected(), false);
    assert.equal(f.video.hidden, true);
    await f.client.disconnect();
    assert.deepEqual(observed, [expected]);
  }
});

test("video subscribed before connect resolves is not overwritten by waiting-media", async () => {
  const f = fixture();
  f.fake.sdk.Room.prototype.connect = async function () {
    this.emit(f.fake.sdk.RoomEvent.TrackSubscribed, f.track("video"));
  };
  await f.connect();
  assert.equal(f.states.at(-1), "streaming");
  assert.equal(f.client.hasVideoTrack(), true);
  await f.client.disconnect();
});

for (const order of [["audio", "video"], ["video", "audio"]]) {
  test(`track arrival ${order.join(" then ")} and removal reflect video presence`, async () => {
    const f = fixture();
    await f.connect();
    const tracks = order.map(f.track);
    for (const item of tracks) {
      f.subscribe(item);
      assert.equal(f.video.hidden, !f.client.hasVideoTrack());
    }
    assert.equal(f.states.at(-1), "streaming");
    f.unsubscribe(tracks.find(t => t.kind === "video"));
    assert.equal(f.client.hasVideoTrack(), false);
    assert.equal(f.video.hidden, true);
    assert.equal(f.states.at(-1), "waiting-media");
    await f.client.disconnect();
  });
}

test("interrupted and stale play promises cannot replace healthy video playback", async () => {
  const f = fixture();
  await f.connect();
  let rejectOld;
  f.video.play = () => new Promise((_, reject) => { rejectOld = reject; });
  f.subscribe(f.track("video"));
  const rejectFirst = rejectOld;
  f.subscribe(f.track("audio"));
  rejectFirst(Object.assign(Error("old failure"), { name: "NotAllowedError" }));
  rejectOld(Object.assign(Error("interrupted by track attachment"), { name: "AbortError" }));
  await Promise.resolve();
  assert.equal(f.states.at(-1), "streaming");
  assert.equal(f.client.hasVideoTrack(), true);
  assert.equal(f.video.hidden, false);
  await f.client.disconnect();
});

test("autoplay denial keeps video controls visible and playing clears the hint", async () => {
  const f = fixture();
  await f.connect();
  f.video.play = async () => { throw Object.assign(Error("gesture required"), { name: "NotAllowedError" }); };
  f.subscribe(f.track("video"));
  await Promise.resolve();
  assert.equal(f.states.at(-1), "playback-gesture-required");
  assert.equal(f.video.hidden, false);
  assert.equal(f.client.hasVideoTrack(), true);
  f.video.emit("playing");
  assert.equal(f.states.at(-1), "streaming");
  await f.client.disconnect();
});

test("late play failures and old room events cannot disturb a new explicit join", async () => {
  const f = fixture();
  await f.connect();
  const oldRoom = f.fake.instance();
  let rejectOld;
  f.video.play = () => new Promise((_, reject) => { rejectOld = reject; });
  f.subscribe(f.track("video"));
  await f.client.disconnect();
  f.video.play = async () => {};
  await f.connect();
  const currentTrack = f.track("video");
  f.subscribe(currentTrack);
  rejectOld(Object.assign(Error("old denial"), { name: "NotAllowedError" }));
  oldRoom.emit(f.fake.sdk.RoomEvent.TrackUnsubscribed, currentTrack);
  oldRoom.emit(f.fake.sdk.RoomEvent.Reconnected);
  await Promise.resolve();
  assert.equal(f.client.isConnected(), true);
  assert.equal(f.client.hasVideoTrack(), true);
  assert.equal(f.states.at(-1), "streaming");
  await f.client.disconnect();
  assert.equal(f.client.hasVideoTrack(), false);
});

test('browser autoplay rejection falls back to muted picture after an explicit start', async () => {
  const f=fixture(); await f.connect(); f.video.muted=false;
  f.video.play=async()=>{if(!f.video.muted)throw Object.assign(Error('gesture expired'),{name:'NotAllowedError'});};
  f.subscribe(f.track('video')); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.video.muted,true);assert.equal(f.video.hidden,false);
  assert.equal(f.client.hasVideoTrack(),true);assert.equal(f.states.at(-1),'streaming');
  await f.client.disconnect();
});

test("explicit connect uses encrypted LiveKit parameters and attaches one subscribed rendition", async () => {
  const fake = fakeSdk();
  const states = [];
  const video = videoElement();
  const client = createCastingMediaClientV1({ loadSdk: async () => fake.sdk,
    clock: () => new Date("2026-09-04T04:00:00.000Z") });
  const result = await client.connect({ connection: connection(), videoElement: video,
    onState: (value) => states.push(value) });
  assert.equal(result.connected, true);
  assert.equal(result.initiallyMuted, true);
  assert.equal(video.muted, true);
  assert.equal(video.playsInline, true);
  assert.deepEqual(fake.instance().connectCalls, [{ url: "wss://casting.test/livekit", token: TOKEN,
    options: { autoSubscribe: true, maxRetries: 0, websocketTimeout: 10_000, peerConnectionTimeout: 10_000 } }]);
  assert.equal(fake.instance().options.adaptiveStream, true);
  assert.equal(fake.instance().options.dynacast, false);
  assert.equal(fake.instance().options.disconnectOnPageLeave, false);
  assert.equal(fake.instance().options.reconnectPolicy.nextRetryDelayInMs(), null);
  const track = { kind: "video", attachCalls: 0, detachCalls: 0,
    attach(element) { assert.equal(element, video); this.attachCalls += 1; },
    detach(element) { assert.equal(element, video); this.detachCalls += 1; } };
  fake.instance().emit(fake.sdk.RoomEvent.TrackSubscribed, track);
  await Promise.resolve();
  assert.equal(track.attachCalls, 1);
  assert.equal(video.hidden, false);
  assert.equal(video.playCalls, 1);
  assert.equal(states.at(-1), "streaming");
  await client.disconnect();
  assert.equal(track.detachCalls, 1);
  assert.equal(video.hidden, true);
  assert.equal(client.isConnected(), false);
});

test("initial SDK retries cannot run forever or claim connected before success", async () => {
  const fake = fakeSdk();
  fake.sdk.Room.prototype.connect = async () => new Promise(() => {});
  const client = createCastingMediaClientV1({ loadSdk: async () => fake.sdk, connectTimeoutMs: 10,
    clock: () => new Date("2026-09-04T04:00:00.000Z") });
  const attempt = client.connect({ connection: connection(), videoElement: videoElement() });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.isConnected(), false);
  await assert.rejects(attempt, error => error.code === "cast_media_connection_unavailable");
  assert.equal(client.isConnected(), false);
});

test("unexpected reconnect or disconnect requires a fresh explicit join", async () => {
  const fake = fakeSdk();
  let disconnected = 0;
  const client = createCastingMediaClientV1({ loadSdk: async () => fake.sdk,
    clock: () => new Date("2026-09-04T04:00:00.000Z") });
  await client.connect({ connection: connection(), videoElement: videoElement(),
    onDisconnected: () => { disconnected += 1; } });
  fake.instance().emit(fake.sdk.RoomEvent.Reconnected);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disconnected, 1);
  assert.equal(client.isConnected(), false);
});

test("source stop clears old picture and audio while preserving the authorized room", async () => {
  const f = fixture();
  await f.connect();
  const videoTrack = { kind: "video", attachCalls: 0, detachCalls: 0,
    attach() { this.attachCalls += 1; }, detach() { this.detachCalls += 1; } };
  const audioTrack = { kind: "audio", attachCalls: 0, detachCalls: 0,
    attach() { this.attachCalls += 1; }, detach() { this.detachCalls += 1; } };
  f.subscribe(videoTrack); f.subscribe(audioTrack);
  await Promise.resolve();
  assert.equal(f.client.suspendSource(), true);
  assert.equal(f.client.isConnected(), true);
  assert.equal(videoTrack.detachCalls, 1); assert.equal(audioTrack.detachCalls, 1);
  assert.equal(f.video.hidden, true); assert.equal(f.states.at(-1), "source-stopped");
  const replacement = { kind: "video", attachCalls: 0,
    attach() { this.attachCalls += 1; }, detach() {} };
  f.subscribe(replacement);
  assert.equal(replacement.attachCalls, 0, "tracks arriving while stopped cannot expose stale media");
  assert.equal(f.client.resumeSource(), true);
  await Promise.resolve();
  assert.equal(videoTrack.attachCalls, 2); assert.equal(audioTrack.attachCalls, 2);
  assert.equal(replacement.attachCalls, 1); assert.equal(f.video.hidden, false);
  assert.equal(f.states.at(-1), "streaming");
  await f.client.disconnect();
});

test("application-owned document disposal is not an unexpected disconnect", async () => {
  const fake = fakeSdk(); let disconnected = 0;
  const client = createCastingMediaClientV1({ loadSdk: async () => fake.sdk,
    clock: () => new Date("2026-09-04T04:00:00.000Z") });
  await client.connect({ connection: connection(), videoElement: videoElement(),
    onDisconnected: () => { disconnected += 1; } });
  assert.equal(fake.instance().options.disconnectOnPageLeave, false);
  await client.disconnect();
  assert.equal(client.isConnected(), false);
  assert.equal(disconnected, 0);
});

test("missing reviewed SDK and expired or plaintext connection fail closed", async () => {
  const client = createCastingMediaClientV1({ loadSdk: async () => { throw new Error("missing"); },
    clock: () => new Date("2026-09-04T04:00:00.000Z") });
  await assert.rejects(client.connect({ connection: connection(), videoElement: videoElement() }),
    (error) => error.code === "cast_media_client_unavailable");
  await assert.rejects(client.connect({ connection: connection({ expiresAt: "2026-09-04T03:00:00.000Z" }),
    videoElement: videoElement() }), (error) => error.code === "cast_media_connection_expired");
  await assert.rejects(client.connect({ connection: connection({ url: "ws://casting.test/livekit" }),
    videoElement: videoElement() }), (error) => error.code === "cast_response_invalid");
  assert.deepEqual(castingMediaClientPolicyV1, {
    sdk: "livekit-client", sdkVersion: "2.21.0",
    modulePath: "/plugins/official.wireless-casting/vendor/livekit-client-2.21.0.esm.mjs",
    encryptedTransportOnly: true, autoReconnectAllowed: false,
    reconnectRequiresFreshExplicitJoin: true, maximumViewerEncodes: 0,
    credentialPersistence: "memory-only", recordingAllowed: false,
  });
});
