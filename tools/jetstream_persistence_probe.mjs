#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";


const mode = process.env.TEAMAIBOX_JETSTREAM_PROBE_MODE;
const runId = process.env.TEAMAIBOX_JETSTREAM_PROBE_RUN_ID;
if (!new Set(["create", "verify", "delete", "absent", "info"]).has(mode)) throw new Error("probe mode is invalid");
if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(runId ?? "")) throw new Error("probe run ID is invalid");
const stream = "TEAMAIBOX_EVENTS";
const subject = `teamaibox.events.v1.qualification.${createHash("sha256").update(runId).digest("hex").slice(0, 16)}`;
const sentinel = Buffer.from(`teamaibox-jetstream-persistence:${runId}`, "utf8");
const sentinelDigest = `sha256:${createHash("sha256").update(sentinel).digest("hex")}`;
const configuredSequence = Number(process.env.TEAMAIBOX_JETSTREAM_PROBE_SEQUENCE ?? 0);
if (mode === "verify" && (!Number.isSafeInteger(configuredSequence) || configuredSequence < 1)) throw new Error("probe sequence is invalid");


class NatsConnection {
  #socket; #buffer = Buffer.alloc(0); #lineWaiters = []; #messages = new Map(); #sid = 1;
  async connect(token) {
    this.#socket = createConnection({ host: "event-bus", port: 4222 });
    this.#socket.on("data", (chunk) => { this.#buffer = Buffer.concat([this.#buffer, chunk]); this.#parse(); });
    this.#socket.on("error", (error) => this.#fail(error));
    await this.#line("INFO", 10_000);
    this.#send(`CONNECT ${JSON.stringify({ auth_token: token, lang: "node", name: "teamaibox-jetstream-qualification", pedantic: false, protocol: 1, verbose: false, version: process.version })}\r\nPING\r\n`);
    await this.#line("PONG", 10_000);
  }
  #send(value) { this.#socket.write(value); }
  #line(prefix, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`NATS ${prefix} timed out`)), timeout);
      this.#lineWaiters.push({ prefix, resolve: (value) => { clearTimeout(timer); resolve(value); }, reject });
      this.#parse();
    });
  }
  #emitLine(line) {
    if (line === "PING") { this.#send("PONG\r\n"); return; }
    const index = this.#lineWaiters.findIndex((item) => line.startsWith(item.prefix));
    if (index >= 0) this.#lineWaiters.splice(index, 1)[0].resolve(line);
  }
  #parse() {
    while (this.#buffer.length) {
      const lineEnd = this.#buffer.indexOf("\r\n");
      if (lineEnd < 0) return;
      const line = this.#buffer.subarray(0, lineEnd).toString("utf8");
      if (line.startsWith("MSG ")) {
        const fields = line.split(" "), size = Number(fields.at(-1)), sid = fields[2];
        const payloadStart = lineEnd + 2, payloadEnd = payloadStart + size;
        if (!Number.isInteger(size) || this.#buffer.length < payloadEnd + 2) return;
        const payload = this.#buffer.subarray(payloadStart, payloadEnd);
        this.#buffer = this.#buffer.subarray(payloadEnd + 2);
        const waiter = this.#messages.get(sid);
        if (waiter) { this.#messages.delete(sid); waiter.resolve(payload); }
        continue;
      }
      this.#buffer = this.#buffer.subarray(lineEnd + 2);
      if (line.startsWith("-ERR")) { this.#fail(new Error("NATS request failed")); return; }
      this.#emitLine(line);
    }
  }
  #fail(error) {
    for (const item of this.#lineWaiters.splice(0)) item.reject(error);
    for (const item of this.#messages.values()) item.reject(error);
    this.#messages.clear();
  }
  async request(target, payload = {}) {
    const sid = String(this.#sid++), inbox = `_INBOX.TAIB.${randomUUID().replaceAll("-", "")}`;
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#messages.delete(sid); reject(new Error("NATS request timed out")); }, 10_000);
      this.#messages.set(sid, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject });
    });
    this.#send(`SUB ${inbox} ${sid}\r\nUNSUB ${sid} 1\r\nPUB ${target} ${inbox} ${body.length}\r\n`);
    this.#socket.write(body); this.#send("\r\n");
    return JSON.parse((await response).toString("utf8"));
  }
  async publish(target, body) {
    const sid = String(this.#sid++), inbox = `_INBOX.TAIB.${randomUUID().replaceAll("-", "")}`;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#messages.delete(sid); reject(new Error("NATS publish timed out")); }, 10_000);
      this.#messages.set(sid, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject });
    });
    this.#send(`SUB ${inbox} ${sid}\r\nUNSUB ${sid} 1\r\nPUB ${target} ${inbox} ${body.length}\r\n`);
    this.#socket.write(body); this.#send("\r\n");
    return JSON.parse((await response).toString("utf8"));
  }
  close() { this.#socket.end(); }
}


function needOk(value, label) {
  if (value?.error) throw new Error(`${label} returned JetStream error ${value.error.err_code ?? value.error.code ?? "unknown"}: ${value.error.description ?? "unspecified"}`);
  return value;
}


const tokenBuffer = await readFile("/var/lib/teamaibox-catalog-secrets/nats-token");
let token = tokenBuffer.toString("utf8").trim(); tokenBuffer.fill(0);
if (token.length < 16) throw new Error("NATS token is unavailable");
const nats = new NatsConnection();
try {
  await nats.connect(token);
  let expectedSequence = configuredSequence;
  if (mode === "absent") {
    const absent = await nats.request(`$JS.API.STREAM.MSG.GET.${stream}`, { last_by_subj: subject });
    if (!absent.error) throw new Error("run-scoped JetStream subject still exists");
    console.log(JSON.stringify({ absent: true, stream, subject }));
  } else if (mode === "info") {
    const info = needOk(await nats.request("$JS.API.INFO"), "account info");
    const listed = needOk(await nats.request("$JS.API.STREAM.LIST", { offset: 0 }), "stream list");
    console.log(JSON.stringify({ limits: info.limits, memory: info.memory, storage: info.storage, streams: info.streams,
      configurations: (listed.streams ?? []).map((item) => ({ name: item.config.name, storage: item.config.storage,
        maxBytes: item.config.max_bytes, maxMessages: item.config.max_msgs, subjects: item.config.subjects })) }));
  } else
  if (mode === "create") {
    const info = needOk(await nats.request(`$JS.API.STREAM.INFO.${stream}`), "stream info");
    if (info.config.storage !== "file" || !(info.config.subjects ?? []).includes("teamaibox.events.v1.>")) throw new Error("product JetStream configuration drifted");
    const absent = await nats.request(`$JS.API.STREAM.MSG.GET.${stream}`, { last_by_subj: subject });
    if (!absent.error) throw new Error("run-scoped JetStream subject already exists");
    const published = needOk(await nats.publish(subject, sentinel), "sentinel publish");
    if (published.stream !== stream || !Number.isSafeInteger(published.seq) || published.seq < 1) throw new Error("JetStream publish acknowledgement drifted");
    expectedSequence = published.seq;
  }
  if (mode === "delete") {
    if (expectedSequence < 1) {
      const current = needOk(await nats.request(`$JS.API.STREAM.MSG.GET.${stream}`, { last_by_subj: subject }), "sentinel lookup");
      expectedSequence = current.message.seq;
    }
    const deleted = needOk(await nats.request(`$JS.API.STREAM.PURGE.${stream}`, { filter: subject }), "sentinel purge");
    if (deleted.success !== true || deleted.purged < 1) throw new Error("JetStream sentinel was not purged");
    const absent = await nats.request(`$JS.API.STREAM.MSG.GET.${stream}`, { seq: expectedSequence });
    if (!absent.error) throw new Error("JetStream sentinel remains after purge");
    console.log(JSON.stringify({ deleted: true, purged: deleted.purged, sequence: expectedSequence, stream, subject }));
  } else if (mode !== "info" && mode !== "absent") {
    const info = needOk(await nats.request(`$JS.API.STREAM.INFO.${stream}`), "stream info");
    const message = needOk(await nats.request(`$JS.API.STREAM.MSG.GET.${stream}`, { seq: expectedSequence }), "message get");
    const bytes = Buffer.from(message.message.data, "base64");
    const observedDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (observedDigest !== sentinelDigest || message.message.subject !== subject || info.state.messages < 1 || info.config.storage !== "file") throw new Error("JetStream persistent sentinel drifted");
    console.log(JSON.stringify({ firstSequence: info.state.first_seq, lastSequence: info.state.last_seq,
      messageCount: info.state.messages, messageDigest: observedDigest, sequence: expectedSequence,
      storage: info.config.storage, stream, subject }));
  }
} finally {
  token = "";
  nats.close();
}
