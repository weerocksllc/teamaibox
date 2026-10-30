import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

const LOGIN = /^[a-z][a-z0-9._-]{2,63}$/;
const KEY = /^[a-z][a-z0-9-]{0,31}$/;

export function parseAgentIdentities(contents) {
  try {
    const value = JSON.parse(contents);
    if (!Array.isArray(value) || value.length < 1 || value.length > 64) throw new Error();
    const definitions = value.map(item => {
      if (!item || Object.keys(item).sort().join(",") !== "key,loginName,proxyOrigin"
        || typeof item.loginName !== "string" || typeof item.key !== "string"
        || !LOGIN.test(item.loginName) || !KEY.test(item.key)) throw new Error();
      const origin = new URL(item.proxyOrigin);
      if (typeof item.proxyOrigin !== "string" || !["http:", "https:"].includes(origin.protocol)
        || origin.username || origin.password || origin.search || origin.hash
        || origin.pathname !== "/" || origin.origin !== item.proxyOrigin) throw new Error();
      return Object.freeze({ loginName: item.loginName, key: item.key, proxyOrigin: origin.origin });
    });
    for (const field of ["loginName", "key", "proxyOrigin"]) {
      if (new Set(definitions.map(item => item[field])).size !== definitions.length) throw new Error();
    }
    return Object.freeze(definitions);
  } catch {
    throw new Error("Agent identities must be an explicit, unique array of loginName, key and proxyOrigin mappings");
  }
}

export async function loadAgentIdentities(filename) {
  if (typeof filename !== "string" || !isAbsolute(filename)) throw new Error("TEAMAIBOX_AGENT_IDENTITIES_FILE must name an absolute protected configuration file");
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 65_536
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error();
    const bytes = Buffer.alloc(65_537);
    try {
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 65_536) throw new Error();
      return parseAgentIdentities(bytes.subarray(0, bytesRead).toString("utf8"));
    } finally { bytes.fill(0); }
  } catch {
    throw new Error("Agent identity configuration is unavailable, unsafe or invalid");
  } finally {
    await file?.close();
  }
}
