import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { observeSessionReadiness } from "../src/auth/session-readiness.mjs";

const sourceUrl = new URL("../src/auth/SessionRealtimeBridge.tsx", import.meta.url);
const authenticatedAppUrl = new URL("../src/auth/AuthenticatedApp.tsx", import.meta.url);

test("authenticated workbench opens and cleans up same-origin session realtime paths", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /observeSessionReadiness\(/);
  assert.match(source, /new URL\("\/ws\/session", globalThis\.location\.href\)/);
  assert.match(source, /socketUrl\.protocol = socketUrl\.protocol === "https:" \? "wss:" : "ws:"/);
  assert.match(source, /stopReadiness\(\)/);
  assert.match(source, /socket\.close\(\)/);
  assert.match(source, /data-sse-state=\{sseState\}/);
  assert.match(source, /data-websocket-state=\{webSocketState\}/);
});

class FakeEventSource {
  static instances = [];
  closed = false;
  listeners = new Map();
  constructor(url) { this.url = url; FakeEventSource.instances.push(this); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  close() { this.closed = true; }
  ready() { this.listeners.get("session.ready")(); }
}

test("readiness releases the HTTP connection in every tab rather than subscribing forever", () => {
  FakeEventSource.instances = [];
  const states = [];
  const stops = Array.from({ length: 8 }, (_, tab) => observeSessionReadiness({
    EventSourceClass: FakeEventSource, onState: state => states.push([tab, state]),
  }));
  for (const events of FakeEventSource.instances) {
    assert.equal(events.url, "/events/session?once=1");
    events.ready();
    assert.equal(events.closed, true);
    events.onerror(); // EOF must not turn a successful probe into an error.
  }
  assert.deepEqual(states, Array.from({ length: 8 }, (_, tab) => [tab, "ready"]));
  stops.forEach(stop => stop());
});

test("readiness error closes the probe and unmount suppresses late callbacks", () => {
  const states = [];
  const stop = observeSessionReadiness({ EventSourceClass: FakeEventSource, onState: state => states.push(state) });
  const failed = FakeEventSource.instances.at(-1);
  failed.onerror();
  assert.equal(failed.closed, true);
  failed.ready();
  stop();
  assert.deepEqual(states, ["error"]);
  const cancel = observeSessionReadiness({ EventSourceClass: FakeEventSource, onState: state => states.push(state) });
  const cancelled = FakeEventSource.instances.at(-1);
  cancel();
  cancelled.ready();
  assert.equal(cancelled.closed, true);
  assert.deepEqual(states, ["error"]);
});

test("sign-in retains the form reference across the asynchronous request", async () => {
  const source = await readFile(authenticatedAppUrl, "utf8");

  assert.match(source, /const form = event\.currentTarget;/);
  assert.match(source, /const session = await signIn/);
  assert.match(source, /form\.reset\(\);/);
  assert.doesNotMatch(source, /await signIn[\s\S]{0,300}event\.currentTarget\.reset/);
});
