import assert from "node:assert/strict";
import test from "node:test";

import { PostgresRealtimeReservationRepository } from "../src/postgres-realtime-reservation-repository.mjs";
import { RealtimeReservationManager } from "../src/realtime-reservation-manager.mjs";

const NOW = new Date("2026-08-10T05:00:00.000Z");

function normalized(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

function sessionRow(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    admission_key: "22222222-2222-4222-8222-222222222222",
    owner_identity_id: "33333333-3333-4333-8333-333333333333",
    correlation_id: "request-realtime-1",
    capability_key: "translation",
    requested_model: "local/realtime-translation",
    model_profile_id: "44444444-4444-4444-8444-444444444444",
    node_id: "55555555-5555-4555-8555-555555555555",
    node_generation: "7",
    route: "local",
    state: "admitted",
    priority_class: "latency",
    scheduler_priority: 100,
    latency_budget_milliseconds: 250,
    reservation: {
      cpuMillis: 1_000, unifiedMemoryBytes: 2_000, acceleratorUnits: 0,
      codecSessions: 1, storageBytes: 0, networkBitsPerSecond: 1_000,
    },
    codec_directions: { encodeSessions: 0, decodeSessions: 1 },
    lease_token: "66666666-6666-4666-8666-666666666666",
    fencing_token: "3",
    connection_id: null,
    admitted_at: NOW,
    connection_deadline_at: new Date(NOW.getTime() + 30_000),
    expires_at: new Date(NOW.getTime() + 60_000),
    connected_at: null,
    heartbeat_at: NOW,
    released_at: null,
    release_reason: null,
    updated_at: NOW,
    ...structuredClone(overrides),
  };
}

class RecordingDatabase {
  queries = [];
  transactions = 0;

  constructor(handler) { this.handler = handler; }
  async query(sql, parameters = []) { return this.handler(normalized(sql), parameters); }
  async transaction(operation) {
    this.transactions += 1;
    return operation({
      query: async (sql, parameters = []) => {
        const compact = normalized(sql);
        this.queries.push({ sql: compact, parameters });
        return this.handler(compact, parameters);
      },
    });
  }
}

function manager(database) {
  return new RealtimeReservationManager({
    repository: new PostgresRealtimeReservationRepository({ database }),
    placementResolver: {
      resolve: async () => [{
        nodeId: sessionRow().node_id,
        nodeGeneration: 7,
        modelProfileId: sessionRow().model_profile_id,
        route: "local",
        resources: sessionRow().reservation,
        codecDirections: sessionRow().codec_directions,
        latencyBudgetMilliseconds: 250,
        observedLatencyMilliseconds: 3,
        warm: true,
      }],
    },
    clock: () => NOW,
  });
}

test("PostgreSQL realtime admission locks and fences identity without pooled resource sums", async () => {
  const database = new RecordingDatabase((sql) => {
    if (sql.includes("WHERE admission_key = $1")) return { rows: [] };
    if (sql.includes("FROM compute.nodes WHERE id = $1 FOR UPDATE")) {
      return { rows: [{
        id: sessionRow().node_id, generation: "7", lifecycle_state: "ready",
        capacity: {
          cpuMillis: 4_000, unifiedMemoryBytes: 8_000, acceleratorUnits: 1,
          codecSessions: 2, storageBytes: 10_000, networkBitsPerSecond: 4_000,
          codec: { encodeSessions: 1, decodeSessions: 2 },
        },
      }] };
    }
    if (sql.startsWith("UPDATE compute.realtime_sessions") && sql.includes("connection_timeout")) return { rows: [] };
    if (sql.includes("FROM compute.node_exclusive_intents")) return { rows: [] };
    if (sql.includes("node_exclusive = true")) return { rows: [] };
    if (sql.includes("FROM ( SELECT reservation FROM compute.lease_sets")) {
      return { rows: [{
        cpu_millis: "0", unified_memory_bytes: "0", accelerator_units: "0",
        codec_sessions: "0", storage_bytes: "0", network_bits_per_second: "0",
      }] };
    }
    if (sql.includes("sum((codec_directions->>'encodeSessions')")) {
      return { rows: [{ encode_sessions: "0", decode_sessions: "0" }] };
    }
    if (sql.startsWith("INSERT INTO compute.node_lease_fences")) return { rows: [{ fencing_token: "3" }] };
    if (sql.startsWith("INSERT INTO compute.realtime_sessions")) return { rows: [sessionRow()] };
    return { rows: [] };
  });
  const admitted = await manager(database).admit({
    ownerIdentityId: sessionRow().owner_identity_id,
    correlationId: sessionRow().correlation_id,
    capability: "translation",
    model: sessionRow().requested_model,
    expiresInSeconds: 60,
    admissionKey: sessionRow().admission_key,
  });
  assert.equal(admitted.state, "admitted");
  assert.equal(database.transactions, 1);
  const statements = database.queries.map((query) => query.sql);
  const nodeLock = statements.findIndex((sql) => sql.includes("FROM compute.nodes WHERE id = $1 FOR UPDATE"));
  const capacity = statements.findIndex((sql) => sql.includes("UNION ALL SELECT reservation FROM compute.realtime_sessions"));
  const fence = statements.findIndex((sql) => sql.startsWith("INSERT INTO compute.node_lease_fences"));
  const insert = statements.findIndex((sql) => sql.startsWith("INSERT INTO compute.realtime_sessions"));
  assert.equal(capacity,-1);
  assert.ok(nodeLock >= 0 && fence > nodeLock && insert > fence);
  assert.equal("leaseToken" in admitted.reservation, false);
});

test("PostgreSQL connection ownership is row locked and disconnect closes the reservation", async () => {
  let state = "admitted";
  let connectionId = null;
  const database = new RecordingDatabase((sql, parameters) => {
    if (sql.startsWith("UPDATE compute.realtime_sessions") && sql.includes("connection_timeout")) return { rows: [] };
    if (sql.includes("WHERE id = $1 AND owner_identity_id = $2 FOR UPDATE")) {
      return { rows: [sessionRow({ state, connection_id: connectionId,
        connected_at: state === "connected" ? NOW : null })] };
    }
    if (sql.includes("FROM compute.nodes WHERE id = $1 FOR SHARE")) {
      return { rows: [{ lifecycle_state: "ready", generation: "7" }] };
    }
    if (sql.includes("SET state = 'connected'")) {
      state = "connected";
      connectionId = parameters[2];
      return { rows: [sessionRow({ state, connection_id: connectionId, connected_at: parameters[3] })] };
    }
    if (sql.includes("SET state = $3, released_at = $4")) {
      state = parameters[2];
      return { rows: [sessionRow({
        state, connection_id: connectionId, connected_at: NOW,
        released_at: parameters[3], release_reason: parameters[4],
      })] };
    }
    return { rows: [] };
  });
  const realtime = manager(database);
  const connected = await realtime.connect({
    ownerIdentityId: sessionRow().owner_identity_id,
    sessionId: sessionRow().id,
    connectionId: "77777777-7777-4777-8777-777777777777",
    now: new Date(NOW.getTime() + 1_000),
  });
  assert.equal(connected.state, "connected");
  const released = await realtime.disconnect({
    ownerIdentityId: sessionRow().owner_identity_id,
    sessionId: sessionRow().id,
    connectionId: "77777777-7777-4777-8777-777777777777",
    now: new Date(NOW.getTime() + 2_000),
  });
  assert.equal(released.state, "released");
  assert.equal(database.queries.filter((query) => query.sql.includes("FOR UPDATE")).length, 2);
});

test("batch SQL does not sum realtime resource settings or write resource bookings", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../src/postgres-lease-repository.mjs", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /SELECT reservation FROM compute\.realtime_sessions/);
  assert.match(source, /if \(input\.nodeExclusive\)\s*\{\s*await transaction\.query\(`\s*INSERT INTO compute\.leases/);
  assert.match(source, /node_exclusive_intents/);
});

test("PostgreSQL realtime repository requires transactions", () => {
  assert.throws(
    () => new PostgresRealtimeReservationRepository({ database: { query() {} } }),
    /query and transaction/,
  );
});
