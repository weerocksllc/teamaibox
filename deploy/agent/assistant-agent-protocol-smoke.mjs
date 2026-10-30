import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

function fatal(error) {
  const message = String(error?.message ?? "unknown")
    .replace(/(password|token|secret|credential|authorization|cookie)(\s*[:=]\s*)\S+/gi, "$1$2[REDACTED]")
    .slice(0, 300);
  process.stderr.write(JSON.stringify({ event: "assistant_agent_protocol.failed", message }) + "\n");
  process.exit(1);
}
process.once("uncaughtException", fatal);
process.once("unhandledRejection", fatal);

const origin = process.env.TEAMAIBOX_AGENT_PLATFORM_ORIGIN || "http://product-platform:8080";
const publicOrigin = process.env.TEAMAIBOX_AGENT_PUBLIC_ORIGIN || "https://platform.test";
const identityKey = process.env.TEAMAIBOX_AGENT_IDENTITY || "owner";
const stateFile = process.env.TEAMAIBOX_AGENT_STATE_FILE || "";
const proofName = process.env.TEAMAIBOX_AGENT_PROOF_NAME || "product-agent-proof.txt";
const expectedContent = process.env.TEAMAIBOX_AGENT_PROOF_CONTENT || "TEAM_AI_BOX_PRODUCT_AGENT=passed\n";
const packageMode = process.env.TEAMAIBOX_AGENT_PACKAGE_MODE || "";
const expect = (value, message) => { if (!value) throw new Error(message); };
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function request(path, { method = "GET", session = null, body = null, headers = {} } = {}) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      accept: "application/json",
      host: new URL(publicOrigin).host,
      "x-forwarded-proto": "https",
      ...(session ? { cookie: session.cookie } : {}),
      ...(session?.csrf ? { "x-csrf-token": session.csrf } : {}),
      ...(body ? { "content-type": "application/json", origin: publicOrigin } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, bytes, json: () => JSON.parse(bytes.toString("utf8")) };
}

async function terminalCode(conversationId, session) {
  const response = await request(`/api/v1/assistant/conversations/${conversationId}/events?after=0&once=1`, { session });
  if (response.status !== 200) return "event_replay_unavailable";
  for (const block of response.bytes.toString("utf8").replaceAll("\r\n", "\n").split("\n\n")) {
    if (!block.split("\n").includes("event: run.failed")) continue;
    const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    try {
      const value = JSON.parse(data);
      const code = value?.data?.error?.code;
      if (typeof code === "string" && /^[a-z][a-z0-9_.-]{1,127}$/.test(code)) return code;
    } catch {}
  }
  return "terminal_code_unavailable";
}

expect(new Set(["owner", "member"]).has(identityKey), "Agent identity fixture is invalid");
const raw = await readFile(`/var/lib/teamaibox-catalog-secrets/${identityKey}.json`);
let owner;
try { owner = JSON.parse(raw.toString("utf8")); } finally { raw.fill(0); }
const login = await request("/api/auth/sign-in", { method: "POST", body: { loginName: owner.loginName, password: owner.password } });
owner.password = "[REDACTED]";
expect(login.status === 200, `Agent sign-in failed: ${login.status}`);
const loginValue = login.json();
const cookie = login.headers.getSetCookie().map((item) => item.split(";", 1)[0]).join("; ");
const session = { cookie, csrf: loginValue.csrfToken };
const conversationResponse = await request("/api/v1/assistant/conversations", {
  method: "POST", session, body: { title: `Product Agent ${proofName}` },
});
expect(conversationResponse.status === 201, `Agent conversation creation failed: ${conversationResponse.status}`);
const conversation = conversationResponse.json();
const idempotency = `product-agent-${randomUUID()}`;
const submitted = await request(`/api/v1/assistant/conversations/${conversation.id}/messages`, {
  method: "POST", session, headers: { "idempotency-key": idempotency },
  body: {
    mode: "agent",
    input: packageMode
      ? `Run exactly this permitted package validation command in the sandbox: teamaibox-package-proof ${packageMode}. Do not run another command. Then briefly report completion.`
      : `Use the write or edit tool to create exactly /workspace/${proofName} with exact content ${JSON.stringify(expectedContent)}. Do not modify another file. Then briefly report completion.`,
  },
});
expect(submitted.status === 202, `Agent submission failed: ${submitted.status}`);
const run = submitted.json().run;
expect(run?.effectiveMode === "agent" && run.routing?.modelKey === "agent.bridge", "Assistant did not select Agent Bridge mode");

let approved = 0;
let detail;
for (let attempt = 0; attempt < 240; attempt += 1) {
  const response = await request(`/api/v1/assistant/conversations/${conversation.id}`, { session });
  expect(response.status === 200, `Agent conversation polling failed: ${response.status}`);
  detail = response.json();
  for (const confirmation of detail.confirmations ?? []) {
    if (confirmation.status !== "pending") continue;
    const decision = await request(`/api/v1/assistant/confirmations/${confirmation.id}/decision`, {
      method: "POST", session, body: { decision: "approved" },
    });
    expect(decision.status === 200 && decision.json().status === "approved", "Agent confirmation approval failed");
    approved += 1;
  }
  const message = detail.messages?.find((item) => item.runId === run.id && item.role === "assistant");
  if (message?.status === "completed") break;
  if (message?.status === "failed" || message?.status === "cancelled") {
    const code = message.status === "failed" ? await terminalCode(conversation.id, session) : "cancelled";
    throw new Error(`Agent run terminated: ${message.status}:${code}`);
  }
  await pause(250);
}
const message = detail?.messages?.find((item) => item.runId === run.id && item.role === "assistant");
expect(message?.status === "completed" && message.effectiveMode === "agent", "Agent run did not complete");
expect(typeof message.content === "string" && message.content.trim(), "Agent returned no visible text");
expect(message.toolCalls?.some((item) => item.status === "succeeded"), "Agent emitted no completed tool event");
expect(packageMode ? approved >= 1 && approved <= 3 : approved === 1,
  packageMode
    ? "Agent package validation did not use a bounded authenticated confirmation sequence"
    : "Agent did not require exactly one authenticated operation confirmation");
const effectiveProofName = packageMode ? `package-proof-${packageMode}.json` : proofName;
const proofBytes = await readFile(`/validation-workspace-${identityKey}/${effectiveProofName}`);
let proofSha256;
let artifactId = null;
try {
  expect(proofBytes.byteLength > 0 && proofBytes.byteLength <= 16 * 1024, "Agent workspace proof size is invalid");
  if (packageMode) {
    const packageProof = JSON.parse(proofBytes.toString("utf8"));
    expect(packageProof.status === "passed" && packageProof.mode === packageMode, "Agent package proof is invalid");
    expect(packageProof.clients?.pip?.importVerified === true, "Agent PIP package was not verified");
    expect(packageProof.clients?.npm?.requireVerified === true, "Agent NPM package was not verified");
    expect(packageProof.clients?.apt?.architecture === "arm64" && packageProof.clients?.apt?.extractedBinaryVerified === true, "Agent APT package was not verified");
    expect(packageProof.hostModified === false && packageProof.directRepositoryCredentialReceived === false, "Agent package boundary proof is invalid");
  } else {
    expect(proofBytes.toString("utf8").includes(expectedContent.trim()), "Agent workspace proof marker is missing");
  }
  proofSha256 = `sha256:${createHash("sha256").update(proofBytes).digest("hex")}`;
  if (!packageMode) {
    expect(message.artifacts?.length === 1, "Agent did not export exactly one protected output artifact");
    const artifact = message.artifacts[0];
    expect(artifact.role === "output" && artifact.label === proofName
      && artifact.mimeType === "text/plain" && artifact.sizeBytes === proofBytes.byteLength
      && artifact.sha256 === proofSha256 && artifact.downloadPath === `/api/v1/assistant/artifacts/${artifact.artifactId}/download`,
    "Agent protected output artifact facts drifted");
    artifactId = artifact.artifactId;
    const download = await request(artifact.downloadPath, { session, headers: { accept: "application/octet-stream" } });
    expect(download.status === 200 && download.bytes.equals(proofBytes), "Agent protected output artifact could not be downloaded");

    const otherIdentity = identityKey === "owner" ? "member" : "owner";
    const otherRaw = await readFile(`/var/lib/teamaibox-catalog-secrets/${otherIdentity}.json`);
    let other;
    try { other = JSON.parse(otherRaw.toString("utf8")); } finally { otherRaw.fill(0); }
    const otherLogin = await request("/api/auth/sign-in", { method: "POST", body: { loginName: other.loginName, password: other.password } });
    other.password = "[REDACTED]";
    expect(otherLogin.status === 200, "Agent isolation identity could not sign in");
    const otherValue = otherLogin.json();
    const otherSession = {
      cookie: otherLogin.headers.getSetCookie().map((item) => item.split(";", 1)[0]).join("; "),
      csrf: otherValue.csrfToken,
    };
    const stolen = await request(artifact.downloadPath, { session: otherSession });
    expect(new Set([403, 404]).has(stolen.status), "Agent protected output artifact leaked across users");
  }
} finally {
  proofBytes.fill(0);
}
const events = await request(`/api/v1/assistant/conversations/${conversation.id}/events?after=0&once=1`, { session });
const eventText = events.bytes.toString("utf8");
for (const name of ["routing.selected", "confirmation.requested", "confirmation.resolved", "tool.started", "tool.completed", "run.completed"]) {
  expect(eventText.includes(`event: ${name}`), `Agent event replay omitted ${name}`);
}
if (!packageMode) expect(eventText.includes("event: artifact.created"), "Agent event replay omitted artifact.created");
if (stateFile) {
  expect(stateFile === `/validation-state/${identityKey}.json`, "Agent validation state target is invalid");
  await mkdir("/validation-state", { recursive: true });
  const temporary = `${stateFile}.next`;
  await writeFile(temporary, JSON.stringify({
    schemaVersion: 1,
    identityKey,
    ownerIdentityId: loginValue.identity.id,
    conversationId: conversation.id,
    runId: run.id,
    proofName: effectiveProofName,
    proofSha256,
    artifactId,
  }) + "\n", { mode: 0o600 });
  await rename(temporary, stateFile);
}
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  status: "passed",
  identityKey,
  ownerIdentityId: loginValue.identity.id,
  conversationId: conversation.id,
  runId: run.id,
  effectiveMode: message.effectiveMode,
  routingModel: message.routing?.modelKey,
  confirmationApprovedExactlyOnce: packageMode ? null : approved === 1,
  packageConfirmationCount: packageMode ? approved : null,
  completedToolObserved: true,
  textResultObserved: true,
  eventReplayComplete: true,
  proofName: effectiveProofName,
  packageMode: packageMode || null,
  proofSha256,
  protectedArtifactObserved: packageMode ? null : true,
  protectedArtifactId: artifactId,
  credentialsRetained: false,
  promptContentRetained: false,
  modelOutputRetained: false,
}) + "\n");
