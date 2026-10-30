import { readFile } from "node:fs/promises";

function fatal(error) {
  const message = String(error?.message ?? "unknown")
    .replace(/(password|token|secret|credential|authorization|cookie)(\s*[:=]\s*)\S+/gi, "$1$2[REDACTED]")
    .slice(0, 300);
  process.stderr.write(JSON.stringify({ event: "assistant_agent_retained.failed", message }) + "\n");
  process.exit(1);
}
process.once("uncaughtException", fatal);
process.once("unhandledRejection", fatal);

const origin = process.env.TEAMAIBOX_AGENT_PLATFORM_ORIGIN || "http://platform-api:8080";
const publicOrigin = process.env.TEAMAIBOX_AGENT_PUBLIC_ORIGIN || "https://platform.test";
const identityKey = process.env.TEAMAIBOX_AGENT_IDENTITY || "owner";
const expect = (value, message) => { if (!value) throw new Error(message); };
expect(new Set(["owner", "member"]).has(identityKey), "Agent identity fixture is invalid");

async function request(path, { method = "GET", session = null, body = null } = {}) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      accept: "application/json",
      host: new URL(publicOrigin).host,
      "x-forwarded-proto": "https",
      ...(session ? { cookie: session.cookie, "x-csrf-token": session.csrf } : {}),
      ...(body ? { "content-type": "application/json", origin: publicOrigin } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, bytes, json: () => JSON.parse(bytes.toString("utf8")) };
}

const declarationBytes = await readFile(`/var/lib/teamaibox-catalog-secrets/${identityKey}.json`);
const stateBytes = await readFile(`/validation-state/${identityKey}.json`);
let declaration;
let state;
try {
  declaration = JSON.parse(declarationBytes.toString("utf8"));
  state = JSON.parse(stateBytes.toString("utf8"));
} finally {
  declarationBytes.fill(0);
  stateBytes.fill(0);
}
expect(state.schemaVersion === 1 && state.identityKey === identityKey, "Agent retained-state identity drifted");
const login = await request("/api/auth/sign-in", {
  method: "POST",
  body: { loginName: declaration.loginName, password: declaration.password },
});
declaration.password = "[REDACTED]";
expect(login.status === 200, `Agent retained sign-in failed: ${login.status}`);
const loginValue = login.json();
const session = {
  cookie: login.headers.getSetCookie().map((item) => item.split(";", 1)[0]).join("; "),
  csrf: loginValue.csrfToken,
};
expect(loginValue.identity.id === state.ownerIdentityId, "Agent retained-state owner drifted");
const detailResponse = await request(`/api/v1/assistant/conversations/${state.conversationId}`, { session });
expect(detailResponse.status === 200, `Agent retained conversation failed: ${detailResponse.status}`);
const detail = detailResponse.json();
const message = detail.messages?.find((item) => item.runId === state.runId && item.role === "assistant");
expect(message?.status === "completed" && message.effectiveMode === "agent", "Agent completed message was not retained");
expect(message.toolCalls?.some((item) => item.status === "succeeded"), "Agent completed tool was not retained");
expect(typeof state.artifactId === "string" && message.artifacts?.some((item) => item.artifactId === state.artifactId
  && item.role === "output" && item.downloadPath === `/api/v1/assistant/artifacts/${state.artifactId}/download`),
"Agent protected output artifact was not retained");
const artifactDownload = await request(`/api/v1/assistant/artifacts/${state.artifactId}/download`, { session });
expect(artifactDownload.status === 200, "Agent retained protected output artifact could not be downloaded");
expect(detail.confirmations?.some((item) => item.agentSessionKey === `assistant-run.${state.runId}` && item.status === "approved"), "Agent approval was not retained");
const events = await request(`/api/v1/assistant/conversations/${state.conversationId}/events?after=0&once=1`, { session });
const eventText = events.bytes.toString("utf8");
for (const name of ["confirmation.requested", "confirmation.resolved", "tool.completed", "artifact.created", "run.completed"]) {
  expect(eventText.includes(`event: ${name}`), `Agent retained events omitted ${name}`);
}
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  status: "passed",
  identityKey,
  ownerIdentityId: state.ownerIdentityId,
  conversationId: state.conversationId,
  runId: state.runId,
  completedMessageRetained: true,
  completedToolRetained: true,
  approvedConfirmationRetained: true,
  protectedArtifactRetained: true,
  artifactId: state.artifactId,
  durableEventReplayPassed: true,
  proofName: state.proofName,
  proofSha256: state.proofSha256,
  credentialsRetained: false,
  contentRetained: false,
}) + "\n");
