import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import pg from "pg";
import { PlatformError } from "../../observability/src/index.mjs";

const { Pool } = pg;
const SAFE_NAME = /^[a-z_][a-z0-9_-]{0,62}$/;
const SAFE_HOST = /^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|\[[0-9a-f:]+\])$/i;

// Only failures known to occur before a request reaches PostgreSQL are safe to
// advertise as retryable. Do not replay SQL or classify an ambiguous lost
// connection/COMMIT acknowledgement as a safely retryable write.
function connectionError(error) {
  if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "57P03"].includes(error?.code)) {
    return new PlatformError("database_temporarily_unavailable", "The database is temporarily unavailable. Please retry shortly.", {
      status: 503, retryable: true, cause: error,
    });
  }
  return error;
}

function integer(value, fallback, minimum, maximum, name) {
  const selected = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return selected;
}

function safeName(value, name) {
  if (typeof value !== "string" || !SAFE_NAME.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function absoluteSecretPath(value, name) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`);
  return value;
}

function passwordProvider(path) {
  return async () => {
    const raw = await readFile(path);
    try {
      if (raw.length < 16 || raw.length > 1024 || raw.includes(0)) {
        throw new TypeError("PostgreSQL password file is invalid");
      }
      const value = raw.toString("utf8").trim();
      if ([...value].length < 16 || [...value].length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError("PostgreSQL password file is invalid");
      }
      return value;
    } finally {
      raw.fill(0);
    }
  };
}

async function tlsConfiguration(environment) {
  const mode = environment.PLATFORM_DATABASE_TLS_MODE || "verify-full";
  if (mode === "disable") return false;
  if (mode !== "verify-full") throw new TypeError("PLATFORM_DATABASE_TLS_MODE is invalid");
  const path = absoluteSecretPath(environment.PLATFORM_DATABASE_CA_FILE, "PLATFORM_DATABASE_CA_FILE");
  const ca = await readFile(path, "utf8");
  if (!ca.includes("-----BEGIN CERTIFICATE-----") || !ca.includes("-----END CERTIFICATE-----") || ca.length > 1024 * 1024) {
    throw new TypeError("PostgreSQL CA file is invalid");
  }
  return Object.freeze({ ca, rejectUnauthorized: true });
}

export class PostgresDatabase {
  #pool;
  #closed = false;

  constructor({ pool }) {
    if (!pool?.query || !pool?.connect || !pool?.end) throw new TypeError("PostgreSQL pool is invalid");
    this.#pool = pool;
  }

  async query(text, parameters = []) {
    if (this.#closed) throw new Error("PostgreSQL database is closed");
    try { return await this.#pool.query(text, parameters); }
    catch (error) { throw connectionError(error); }
  }

  async #connect() {
    try { return await this.#pool.connect(); }
    catch (error) { throw connectionError(error); }
  }

  async transaction(operation) {
    if (this.#closed) throw new Error("PostgreSQL database is closed");
    if (typeof operation !== "function") throw new TypeError("PostgreSQL transaction operation is invalid");
    const client = await this.#connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const result = await operation(Object.freeze({
        query: (text, parameters = []) => client.query(text, parameters),
      }));
      await client.query("COMMIT");
      committed = true;
      return result;
    } catch (error) {
      if (!committed) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "PostgreSQL transaction and rollback failed");
        }
      }
      throw error;
    } finally {
      client.release(committed ? undefined : true);
    }
  }

  async beginConsistentSnapshot() {
    if (this.#closed) throw new Error("PostgreSQL database is closed");
    const client = await this.#connect();
    let finished = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await client.query(`SELECT pg_export_snapshot() AS snapshot_id,
        pg_current_wal_lsn()::text AS postgres_lsn, clock_timestamp() AS started_at`);
      const row = result?.rows?.[0];
      if (typeof row?.snapshot_id !== "string" || !/^[0-9A-Fa-f-]{5,96}$/.test(row.snapshot_id)
          || typeof row?.postgres_lsn !== "string" || !/^[0-9A-F]+\/[0-9A-F]+$/.test(row.postgres_lsn)
          || !Number.isFinite(new Date(row?.started_at).getTime())) {
        throw new Error("PostgreSQL consistent snapshot facts are invalid");
      }
      return Object.freeze({
        snapshotId: row.snapshot_id,
        postgresLsn: row.postgres_lsn,
        startedAt: new Date(row.started_at).toISOString(),
        query: (text, parameters = []) => {
          if (finished) throw new Error("PostgreSQL consistent snapshot is closed");
          return client.query(text, parameters);
        },
        finish: async (outcome = "completed") => {
          if (finished) return;
          finished = true;
          try {
            await client.query(outcome === "completed" ? "COMMIT" : "ROLLBACK");
          } finally {
            client.release(outcome === "completed" ? undefined : true);
          }
        },
      });
    } catch (error) {
      if (!finished) {
        try { await client.query("ROLLBACK"); } catch {}
        client.release(true);
      }
      throw error;
    }
  }

  async ready() {
    const result = await this.query("SELECT 1::integer AS ready");
    if (result?.rows?.[0]?.ready !== 1) throw new Error("PostgreSQL readiness query failed");
    return true;
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#pool.end();
  }
}

export async function createPostgresDatabaseFromEnvironment(environment = process.env, {
  PoolClass = Pool,
  onPoolError = () => {},
} = {}) {
  if (environment.PLATFORM_DATABASE_URL || environment.DATABASE_URL) {
    throw new TypeError("Database URLs are not accepted; use discrete settings and a password file");
  }
  const host = environment.PLATFORM_DATABASE_HOST;
  if (typeof host !== "string" || host.length > 253 || !SAFE_HOST.test(host)) {
    throw new TypeError("PLATFORM_DATABASE_HOST is invalid");
  }
  const port = integer(environment.PLATFORM_DATABASE_PORT, 5432, 1, 65535, "PLATFORM_DATABASE_PORT");
  const database = safeName(environment.PLATFORM_DATABASE_NAME || "teamaibox", "PLATFORM_DATABASE_NAME");
  const user = safeName(environment.PLATFORM_DATABASE_USER || "teamaibox", "PLATFORM_DATABASE_USER");
  const passwordFile = absoluteSecretPath(
    environment.PLATFORM_DATABASE_PASSWORD_FILE,
    "PLATFORM_DATABASE_PASSWORD_FILE",
  );
  const max = integer(environment.PLATFORM_DATABASE_POOL_MAX, 10, 1, 32, "PLATFORM_DATABASE_POOL_MAX");
  const connectionTimeoutMillis = integer(
    environment.PLATFORM_DATABASE_CONNECT_TIMEOUT_MS, 5_000, 250, 60_000,
    "PLATFORM_DATABASE_CONNECT_TIMEOUT_MS",
  );
  const statementTimeout = integer(
    environment.PLATFORM_DATABASE_STATEMENT_TIMEOUT_MS, 30_000, 1_000, 300_000,
    "PLATFORM_DATABASE_STATEMENT_TIMEOUT_MS",
  );
  const pool = new PoolClass({
    host,
    port,
    database,
    user,
    password: passwordProvider(passwordFile),
    ssl: await tlsConfiguration(environment),
    application_name: "teamaibox-platform-api",
    max,
    connectionTimeoutMillis,
    idleTimeoutMillis: 30_000,
    statement_timeout: statementTimeout,
    query_timeout: statementTimeout + 5_000,
    keepAlive: true,
    allowExitOnIdle: false,
  });
  if (typeof pool.on === "function") pool.on("error", onPoolError);
  return new PostgresDatabase({ pool });
}
