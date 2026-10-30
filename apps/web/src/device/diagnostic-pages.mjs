// Fetch in bounded pages without silently dropping the remaining records.
export async function loadDiagnosticPages(request, path, collections) {
  let result = null, cursor = null;
  const seen = new Set();
  do {
    const page = await request(`${path}${cursor ? `${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (!page || collections.some((key) => !Array.isArray(page[key]))) throw new Error("诊断服务返回了无效数据，请重试。");
    if (!result) result = { ...page, ...Object.fromEntries(collections.map((key) => [key, []])) };
    for (const key of collections) for (const item of page[key]) result[key].push(item);
    cursor = page.nextCursor ?? null;
    if (cursor !== null) {
      if (typeof cursor !== "string" || !cursor || seen.has(cursor)) throw new Error("诊断记录翻页失败，请重试。");
      seen.add(cursor);
    }
  } while (cursor);
  return { ...result, nextCursor: null };
}
