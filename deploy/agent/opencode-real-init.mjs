import { randomBytes } from "node:crypto";
import { chown, mkdir, writeFile } from "node:fs/promises";

for (const path of [
  "/runtime/secrets",
  "/runtime/xdg-config/opencode",
  "/workspace/.teamaibox/home",
  "/workspace/.teamaibox/data",
  "/workspace/.teamaibox/cache",
]) {
  await mkdir(path, { recursive: true });
}

const password = randomBytes(48).toString("base64url");
const bridgeToken = randomBytes(48).toString("base64url");
try {
  await writeFile("/runtime/secrets/opencode-password", password, { mode: 0o400, flag: "wx" });
  await writeFile("/runtime/secrets/agent-bridge-token", bridgeToken, { mode: 0o400, flag: "wx" });
} finally {
  // Strings cannot be zeroed, but the value never leaves this networkless
  // one-shot initializer and is not included in command or evidence output.
}
await writeFile("/runtime/xdg-config/opencode/opencode.json", `${JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  autoupdate: false,
  share: "disabled",
  autoshare: false,
  plugin: [],
  permission: "ask",
  enabled_providers: [],
})}\n`, { mode: 0o444, flag: "wx" });
await writeFile(
  "/runtime/xdg-config/opencode/.gitignore",
  "node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n",
  { mode: 0o444, flag: "wx" },
);
await chown("/runtime/secrets/opencode-password", 65532, 65532);
await chown("/runtime/secrets/agent-bridge-token", 65532, 65532);
await chown("/workspace", 65532, 65532);
for (const path of [
  "/workspace/.teamaibox",
  "/workspace/.teamaibox/home",
  "/workspace/.teamaibox/data",
  "/workspace/.teamaibox/cache",
]) {
  await chown(path, 65532, 65532);
}
