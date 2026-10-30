import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createWirelessCastingPluginServer } from "../src/server.mjs";
import { outputSelectionV1, outputHealthLabelV1, workspaceVisibleV1, videoVisibleV1 } from "../src/public/casting-ui-policy-v1.mjs";

test("browser-only page contains no physical output picker or desktop instructions", async () => {
  const html = await readFile(new URL("../src/public/index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../src/public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /HDMI|sink-hdmi|sink-browser|name="output"/);
  assert.doesNotMatch(script, /HDMI|sink-hdmi|sink-browser/);
  assert.ok(html.indexOf('id="browser-video"') < html.indexOf('id="casting-form"'));
});

test("player visibility follows authorized video presence, never a transient playback hint", async () => {
  for (const playbackState of ["streaming", "waiting-media", "playback-gesture-required", "playback-failed"]) {
    assert.equal(videoVisibleV1({ joined: true, hasVideoTrack: true, playbackState }), true);
    assert.equal(videoVisibleV1({ joined: false, hasVideoTrack: true, playbackState }), false);
    assert.equal(videoVisibleV1({ joined: true, hasVideoTrack: false, playbackState }), false);
  }
  const source = await readFile(new URL("../src/public/app.js", import.meta.url), "utf8");
  const render = source.slice(source.indexOf("function renderPlayer("), source.indexOf("function renderInvitees("));
  assert.match(render, /videoVisibleV1\(\{ joined, hasVideoTrack: mediaClient.hasVideoTrack\(\) \}\)/);
  assert.doesNotMatch(render, /mediaConnectionState === "streaming"/);
});

test("the real pinned player is served locally with its license, not a mocked import", async () => {
  const server = createWirelessCastingPluginServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/plugins/official.wireless-casting/vendor/`;
    const response = await fetch(base + "livekit-client-2.21.0.esm.mjs");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /javascript/);
    const raw = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash("sha256").update(raw).digest("hex"), "6546fea33c8972f89d11900a1e08dca1603011be6b05b2118cdbdf4b443c8964");
    const sdk = await import("../src/public/vendor/livekit-client-2.21.0.esm.mjs");
    assert.equal(typeof sdk.Room, "function");
    assert.ok(sdk.RoomEvent.TrackSubscribed);
    assert.equal((await fetch(base + "livekit-client-LICENSE.txt")).status, 200);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("unavailable HDMI cannot remain selected and browser permission is respected", () => {
  const availability = { outputs: { hdmi: { state: "unavailable" }, browser: { state: "available" } } };
  const args = { availability, canView: true, selected: { hdmi: true, browser: false } };
  assert.deepEqual(outputSelectionV1(args), { enabled: { browser: true }, checked: { browser: true } });
  assert.deepEqual(outputSelectionV1({ ...args, canView: false }), { enabled: { browser: false }, checked: { browser: false } });
  assert.equal(outputSelectionV1({ ...args, activeOutputs: ["hdmi"] }).checked.hdmi, undefined);
  assert.equal(outputSelectionV1({ ...args, availability: null }).enabled.browser, false);
});

test("pairing does not pretend to have media, and real output faults remain visible", () => {
  const session = { state: "pairing", outputHealth: { receiverHealthy: true, outputs: { browser: "unavailable" } } };
  assert.equal(outputHealthLabelV1(session, "browser"), "waiting");
  assert.equal(outputHealthLabelV1({ ...session, state: "streaming" }, "browser"), "unavailable");
  assert.equal(outputHealthLabelV1({ ...session, outputHealth: null }, "browser"), "unknown");
  assert.equal(outputHealthLabelV1({ ...session, outputHealth: { ...session.outputHealth, receiverHealthy: false } }, "browser"), "unavailable");
});

test("authorized existing session controls survive an advisory readiness outage", async () => {
  assert.equal(workspaceVisibleV1({ capabilityReady: false, session: { perspective: "initiator" } }), true);
  assert.equal(workspaceVisibleV1({ capabilityReady: false, session: { perspective: "manager" } }), true);
  assert.equal(workspaceVisibleV1({ capabilityReady: false, session: null }), false);
  const source = await readFile(new URL("../src/public/app.js", import.meta.url), "utf8");
  const refresh = source.slice(source.indexOf("async function refresh()"), source.indexOf("function draft()"));
  assert.doesNotMatch(refresh, /show\(\$\("#global-error"\), ""\)/);
  assert.match(refresh, /if \(!state.actorIdentityId \|\| state.refreshing\) return/);
  assert.match(source, /\$\("#join"\)\.disabled = state.busy \|\| !state.capabilityReady/);
});
