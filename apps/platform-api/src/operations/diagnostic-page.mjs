import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function invalid() { throw new PlatformError("diagnostic_cursor_invalid", "Diagnostic page cursor is invalid", { status: 400 }); }

// This bounds one response, not the number of records that can be retrieved.
export function diagnosticPageSize(value = 1000) {
  if (!Number.isInteger(value) || value < 1 || value > 5000) {
    throw new PlatformError("diagnostic_page_size_invalid", "Page size must be between 1 and 5000", { status: 400 });
  }
  return value;
}

export function readDiagnosticCursor(cursor, scope, keys) {
  if (cursor == null) return Object.fromEntries(keys.map((key) => [key, null]));
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalid();
  let value;
  try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { invalid(); }
  if (value?.scope !== scope || !value.positions || Array.isArray(value.positions)
      || Object.keys(value.positions).length !== keys.length) invalid();
  for (const key of keys) {
    const position = value.positions[key];
    if (position === false) continue; // This collection was exhausted on the previous page.
    if (!position || !UUID.test(position.id ?? "") || typeof position.at !== "string"
        || !Number.isFinite(Date.parse(position.at)) || new Date(position.at).toISOString() !== position.at) invalid();
  }
  return value.positions;
}

export function diagnosticPage(rows, limit, idField, timeField) {
  const data = rows.slice(0, limit), last = data.at(-1);
  return { data, position: rows.length > limit ? { id: last[idField], at: new Date(last[timeField]).toISOString() } : false };
}

export function writeDiagnosticCursor(scope, positions) {
  return Object.values(positions).some((position) => position !== false)
    ? Buffer.from(JSON.stringify({ scope, positions })).toString("base64url") : null;
}
