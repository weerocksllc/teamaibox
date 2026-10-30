import { createHash } from "node:crypto";

// Page size is an I/O batch, never a limit on the complete exported collection.
export async function* diagnosticRows(repository, method, filters, idField, timeField, project, signal) {
  let before = null;
  do {
    signal?.throwIfAborted();
    const rows = await repository[method]({ ...filters, before, limit: 1000 });
    if (!rows.length) return;
    const last = rows.at(-1), next = { id: last[idField], at: new Date(last[timeField]).toISOString() };
    if (before && (next.at > before.at || (next.at === before.at && next.id >= before.id))) {
      throw new Error("Diagnostic export page did not advance");
    }
    for (const row of rows) { signal?.throwIfAborted(); yield project(row); }
    before = next;
    if (rows.length < 1000) return;
  } while (true);
}

// A failed or abandoned transfer has no complete JSON document and cannot be
// mistaken for a successful partial export. Only metadata/digest is persisted.
export async function* diagnosticExportStream({ header, collections, expiresAt, complete, signal }) {
  const digest = createHash("sha256"), counts = {};
  const part = (text) => { digest.update(text); return text; };
  yield part(JSON.stringify(header).slice(0, -1));
  for (const [key, values] of Object.entries(collections)) {
    yield part(`,${JSON.stringify(key)}:[`);
    let count = 0;
    for await (const value of values) {
      signal?.throwIfAborted();
      yield part(`${count ? "," : ""}${JSON.stringify(value)}`);
      count++;
    }
    counts[key] = count;
    yield part("]");
  }
  const ending = `,"expiresAt":${JSON.stringify(expiresAt)}`;
  digest.update(ending + "}");
  const bundleDigest = `sha256:${digest.digest("hex")}`;
  signal?.throwIfAborted();
  await complete({ counts, bundleDigest });
  yield ending + `,"bundleDigest":${JSON.stringify(bundleDigest)}}`;
}
