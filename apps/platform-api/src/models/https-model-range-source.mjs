const MAX_REDIRECTS = 5;

export class ModelRangeSourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ModelRangeSourceError";
    this.code = code;
  }
}

function fail(code, message) { throw new ModelRangeSourceError(code, message); }
function safeUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail("model_source_uri_invalid", "model source URI is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password) fail("model_source_uri_invalid", "model range source requires credential-free HTTPS");
  return url;
}

/** Bounded HTTPS Range adapter; one response can never exceed one model chunk. */
export class HttpsModelRangeSource {
  constructor({
    fetchImplementation = globalThis.fetch,
    timeoutMilliseconds = 120_000,
    allowedRedirectHosts = [],
  } = {}) {
    if (typeof fetchImplementation !== "function") throw new TypeError("Fetch implementation is required");
    if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) throw new TypeError("range timeout is invalid");
    this.fetch = fetchImplementation;
    this.timeoutMilliseconds = timeoutMilliseconds;
    this.allowedRedirectHosts = new Set(allowedRedirectHosts);
  }

  async fetchRange({ uri, start, end, etag = null, lastModified = null }) {
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end < start
      || end - start + 1 > 64 * 1024 * 1024) fail("model_source_range_invalid", "model byte range is invalid or too large");
    let current = safeUrl(uri);
    const originalHost = current.host;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMilliseconds);
    try {
      for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
        const headers = { Range: `bytes=${start}-${end}`, Accept: "application/octet-stream" };
        if (etag) headers["If-Range"] = etag;
        else if (lastModified) headers["If-Range"] = lastModified;
        let response;
        try {
          response = await this.fetch(current, {
            method: "GET", headers, redirect: "manual", credentials: "omit",
            cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal,
          });
        } catch (error) {
          if (error?.name === "AbortError") fail("model_source_timeout", "model range request timed out");
          fail("model_source_unavailable", "model range request failed");
        }
        if (new Set([301, 302, 303, 307, 308]).has(response.status)) {
          if (redirect === MAX_REDIRECTS) fail("model_source_redirect_invalid", "model source exceeded redirect limit");
          const location = response.headers.get("location");
          const target = safeUrl(new URL(location, current).href);
          if (target.host !== originalHost && !this.allowedRedirectHosts.has(target.host)) {
            fail("model_source_redirect_invalid", "model source redirected to an unapproved host");
          }
          current = target;
          continue;
        }
        const expectedSize = end - start + 1;
        if (![200, 206].includes(response.status)) fail("model_source_http_error", `model source returned HTTP ${response.status}`);
        const contentLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength !== expectedSize) fail("model_source_range_invalid", "model source content length is not the requested range");
        let totalSize;
        if (response.status === 206) {
          const match = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(response.headers.get("content-range") ?? "");
          if (!match || Number(match[1]) !== start || Number(match[2]) !== end) fail("model_source_range_invalid", "model source Content-Range is invalid");
          totalSize = Number(match[3]);
        } else {
          if (start !== 0 || !Number.isFinite(contentLength) || contentLength !== expectedSize) fail("model_source_range_invalid", "model source ignored a partial Range request");
          totalSize = contentLength;
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.byteLength !== expectedSize) {
          bytes.fill(0);
          fail("model_source_range_invalid", "model source body is not the requested range");
        }
        return {
          status: response.status, bytes, totalSize,
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified"),
          finalUri: current.href,
        };
      }
      fail("model_source_redirect_invalid", "model source exceeded redirect limit");
    } finally {
      clearTimeout(timer);
    }
  }
}
