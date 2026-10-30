import { mkdir, readFile, writeFile } from "node:fs/promises";
const path = "/var/lib/teamaibox-browser-canary/schema";
await mkdir("/var/lib/teamaibox-browser-canary", { recursive: true });
const current = await readFile(path, "utf8").catch(() => null);
if (current !== "browser-schema-v1\n") await writeFile(path, "browser-schema-v1\n", { mode: 0o600 });
console.log(JSON.stringify({ applied: current === null, idempotent: current === "browser-schema-v1\n" }));
