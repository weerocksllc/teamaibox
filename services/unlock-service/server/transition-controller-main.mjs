import { createServer } from "node:net";
import { chmod, chown, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { extractControllerJsonLine } from "../src/controller-jsonl-protocol.mjs";
import { Luks2TransitionController } from "../src/luks2-transition-controller.mjs";

const SOCKET = "/run/teamaibox-encryption-controller/controller.sock";
const controller = new Luks2TransitionController({ luksRoot: "/run/teamaibox-luks", backupRoot: "/var/lib/teamaibox-luks-header-backups",
  policyRoot: "/var/lib/teamaibox-encryption-policy", failNonAutomaticPolicyOnce: process.env.TEAMAIBOX_TRANSITION_FAIL_NONAUTOMATIC_ONCE === "true" });
await controller.initialize(); await mkdir(dirname(SOCKET), { recursive: true, mode: 0o750 });
await chmod(dirname(SOCKET), 0o755); await rm(SOCKET, { force: true });
const server = createServer((socket) => {
  let bytes = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    const combined = Buffer.concat([bytes, chunk]); bytes.fill(0); bytes = combined;
    if (bytes.byteLength > 65_536) { bytes.fill(0); bytes = Buffer.alloc(0); socket.destroy(); return; }
    const extracted = extractControllerJsonLine(bytes); if (!extracted) return;
    const raw = extracted.frame; bytes = extracted.remainder;
    void (async () => {
      let request;
      try {
        request = JSON.parse(raw.toString("utf8"));
        if (!request || typeof request.id !== "string" || typeof request.operation !== "string" || !request.input || typeof request.input !== "object") throw new Error("invalid request");
        const result = await controller.handle(request.operation, request.input);
        socket.end(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
      } catch (error) { socket.end(`${JSON.stringify({ id: request?.id ?? null, ok: false, error: { code: "controller_operation_failed" } })}\n`); }
      finally { raw.fill(0); }
    })();
  });
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(SOCKET, resolve); });
await chmod(SOCKET, 0o660); await chown(SOCKET, 1000, 1000);
const close = () => server.close(); process.once("SIGTERM", close); process.once("SIGINT", close);
server.once("close", () => { void rm(SOCKET, { force: true }); });
