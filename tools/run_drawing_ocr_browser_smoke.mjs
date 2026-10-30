#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const ROOT = resolve(new URL("..", import.meta.url).pathname),
  DEFAULT_CHROME =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RUN_ID = /^drawing-ocr-browser-[0-9]{8}-[a-z0-9][a-z0-9-]{1,63}$/,
  SHA = /^sha256:[0-9a-f]{64}$/;
class BrowserSmokeError extends Error {}
const need = (v, m) => {
    if (!v) throw new BrowserSmokeError(m);
  },
  sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sort = (v) =>
  Array.isArray(v)
    ? v.map(sort)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sort(v[k])]),
        )
      : v;
const canonical = (v) => Buffer.from(JSON.stringify(sort(v))),
  digest = (b) => `sha256:${createHash("sha256").update(b).digest("hex")}`;

function args(argv) {
  const v = {};
  for (let i = 0; i < argv.length; i += 2) {
    need(
      argv[i]?.startsWith("--") && argv[i + 1],
      "browser arguments are incomplete",
    );
    v[argv[i].slice(2)] = argv[i + 1];
  }
  for (const k of [
    "origin",
    "run-id",
    "deployment-evidence",
    "output",
    "screenshots",
  ])
    need(typeof v[k] === "string", `${k} is required`);
  const origin = new URL(v.origin);
  need(
    origin.protocol === "https:" &&
      origin.pathname === "/" &&
      !origin.username &&
      !origin.password,
    "browser origin must be exact HTTPS",
  );
  need(RUN_ID.test(v["run-id"]), "browser run ID is invalid");
  const out = {
    origin: origin.href,
    runId: v["run-id"],
    deploymentEvidence: resolve(v["deployment-evidence"]),
    output: resolve(v.output),
    screenshots: resolve(v.screenshots),
    chrome: v.chrome ?? DEFAULT_CHROME,
  };
  for (const p of [out.deploymentEvidence, out.output, out.screenshots]) {
    const r = relative(ROOT, p);
    need(
      r && r !== ".." && !r.startsWith("../"),
      "browser artifact escapes repository",
    );
  }
  return out;
}
async function credentials() {
  const parts = [];
  for await (const c of process.stdin) parts.push(Buffer.from(c));
  const raw = Buffer.concat(parts);
  try {
    const v = JSON.parse(raw.toString("utf8")),
      a = [
        { key: "owner", role: "owner", value: v.owner },
        { key: "ordinary-user", role: "member", value: v.member },
      ];
    for (const x of a)
      need(
        typeof x.value?.loginName === "string" &&
          typeof x.value?.password === "string" &&
          x.value.password.length >= 8,
        `${x.key} credential unavailable`,
      );
    return a;
  } finally {
    raw.fill(0);
  }
}
async function port() {
  const s = createServer();
  await new Promise((r, j) => {
    s.once("error", j);
    s.listen(0, "127.0.0.1", r);
  });
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function waitJson(url) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return r.json();
    } catch {}
    await sleep(100);
  }
  throw new BrowserSmokeError("Chrome DevTools unavailable");
}
class Cdp {
  #s;
  #id = 1;
  #pending = new Map();
  #events = new Map();
  static async connect(url) {
    const c = new Cdp();
    c.#s = new WebSocket(url);
    await new Promise((r, j) => {
      c.#s.addEventListener("open", r, { once: true });
      c.#s.addEventListener("error", j, { once: true });
    });
    c.#s.addEventListener("message", (e) => c.#message(e));
    return c;
  }
  #message(e) {
    const v = JSON.parse(String(e.data));
    if (v.id) {
      const p = this.#pending.get(v.id);
      if (!p) return;
      this.#pending.delete(v.id);
      clearTimeout(p.t);
      v.error
        ? p.j(new BrowserSmokeError(`CDP ${p.m} failed: ${v.error.message}`))
        : p.r(v.result ?? {});
      return;
    }
    for (const h of this.#events.get(v.method) ?? []) h(v.params ?? {});
  }
  on(m, h) {
    const a = this.#events.get(m) ?? [];
    a.push(h);
    this.#events.set(m, a);
  }
  send(m, p = {}) {
    const id = this.#id++;
    return new Promise((r, j) => {
      const t = setTimeout(() => {
        this.#pending.delete(id);
        j(new BrowserSmokeError(`CDP ${m} timed out`));
      }, 30000);
      this.#pending.set(id, { m, r, j, t });
      this.#s.send(JSON.stringify({ id, method: m, params: p }));
    });
  }
  async eval(expression) {
    const x = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (x.exceptionDetails)
      throw new BrowserSmokeError(
        x.exceptionDetails.exception?.description ??
          x.exceptionDetails.text ??
          "browser evaluation failed",
      );
    return x.result?.value;
  }
  async wait(expression, label, ms = 30000) {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
      last = await this.eval(expression).catch((e) => ({ error: e.message }));
      if (last?.ready === true) return last;
      await sleep(250);
    }
    throw new BrowserSmokeError(
      `${label} not ready: ${JSON.stringify(last).slice(0, 250)}`,
    );
  }
  close() {
    for (const p of this.#pending.values()) {
      clearTimeout(p.t);
      p.j(new BrowserSmokeError("browser shutdown"));
    }
    this.#pending.clear();
    this.#s.close();
  }
}
const setter = (selector, value) =>
  `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;const p=e.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,"value").set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));return true})()`;
const frame = (plugin, expression) =>
  `(()=>{const iframe=globalThis.document.querySelector('iframe[src^="/plugins/${plugin}"]'),frameDocument=iframe?.contentDocument;if(!frameDocument)return null;const document=frameDocument;return (${expression})})()`;

async function signIn(cdp, origin, account) {
  const o = new URL(origin).origin;
  await cdp.send("Page.navigate", { url: "about:blank" });
  await cdp.wait(`(()=>({ready:location.href==="about:blank"}))()`, "blank");
  await cdp.send("Storage.clearDataForOrigin", {
    origin: o,
    storageTypes:
      "cookies,local_storage,session_storage,indexeddb,cache_storage,service_workers",
  });
  await cdp.send("Network.clearBrowserCookies");
  await cdp.send("Page.navigate", { url: origin });
  await cdp.wait(
    `(()=>({ready:Boolean(document.querySelector("#login-name")&&!document.querySelector("#login-name").disabled)}))()`,
    `${account.key} sign-in`,
    30000,
  );
  need(
    await cdp.eval(setter("#login-name", account.value.loginName)),
    "login input missing",
  );
  need(
    await cdp.eval(setter("#login-password", account.value.password)),
    "password input missing",
  );
  await cdp.eval(`document.querySelector("form.auth-form").requestSubmit()`);
  await cdp.wait(
    `(()=>({ready:Boolean(document.querySelector(".app-frame")),error:document.querySelector(".auth-alert")?.textContent||null}))()`,
    `${account.key} workspace`,
    30000,
  );
}
async function open(cdp, label, plugin) {
  await cdp.wait(
    `(()=>{const b=[...document.querySelectorAll("button.application-card")].find(x=>${label}.test(x.innerText));return{ready:Boolean(b&&!b.disabled)}})()`,
    `${plugin} card`,
    30000,
  );
  await cdp.eval(
    `(()=>{[...document.querySelectorAll("button.application-card")].find(x=>${label}.test(x.innerText)).click();return true})()`,
  );
  return cdp.wait(
    frame(
      plugin,
      `(()=>({ready:document.readyState==="complete"&&Boolean(document.querySelector("#submit")),experimental:document.querySelector("#model-tier")?.hidden===false,error:document.querySelector("#form-error")?.textContent||null}))()`,
    ),
    `${plugin} iframe`,
    30000,
  );
}
async function shot(cdp, dir, key) {
  const x = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      fromSurface: true,
    }),
    b = Buffer.from(x.data, "base64");
  need(
    b
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "screenshot invalid",
  );
  const p = join(dir, `${key}.png`);
  await writeFile(p, b, { flag: "wx" });
  return { path: relative(ROOT, p), digest: digest(b) };
}
async function download(cdp, dir, action, label) {
  const before = new Set(await readdir(dir));
  await action();
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const files = (await readdir(dir)).filter(
      (x) => !x.endsWith(".crdownload") && !before.has(x),
    );
    if (files.length === 1) return join(dir, files[0]);
    await sleep(100);
  }
  throw new BrowserSmokeError(`${label} download missing`);
}

async function drawing(cdp, account, downloads, runId) {
  const opened = await open(cdp, "/AI 绘图|AI Drawing/", "official.drawing");
  need(opened.experimental, "drawing experimental badge missing");
  need(
    await cdp.eval(
      frame(
        "official.drawing",
        setter("#prompt", `Team AI Box edge compute landscape ${runId}`),
      ),
    ),
    "drawing prompt missing",
  );
  await cdp.eval(
    frame(
      "official.drawing",
      `(()=>{document.querySelector("#steps").value="4";document.querySelector("#size").value="512x512";document.querySelector("#seed").value="73129";document.querySelector("#drawing-form").requestSubmit();return true})()`,
    ),
  );
  await cdp.wait(
    frame(
      "official.drawing",
      `(()=>({ready:document.querySelector("#job-view")?.hidden===false&&!document.querySelector("#cancel-job")?.disabled,status:document.querySelector("#job-status")?.dataset.status||null,error:document.querySelector("#form-error")?.textContent||document.querySelector("#result-error")?.textContent||null}))()`,
    ),
    "drawing queued",
    60000,
  );
  const first = await cdp.wait(
    frame(
      "official.drawing",
      `(()=>{const img=document.querySelector("#gallery img");return{ready:document.querySelector("#job-status")?.dataset.status==="succeeded"&&Boolean(img?.complete&&img.naturalWidth>0),cards:document.querySelectorAll("#gallery .result-card").length,metadata:document.querySelectorAll("#metadata code").length,error:document.querySelector("#result-error")?.textContent||null}})()`,
    ),
    "drawing generation",
    360000,
  );
  need(
    first.cards >= 1 && first.metadata >= 7,
    "drawing result metadata incomplete",
  );
  const firstDownload = await download(
    cdp,
    downloads,
    () =>
      cdp.eval(
        frame(
          "official.drawing",
          `document.querySelector("#gallery a[download]").click(),true`,
        ),
      ),
    "drawing export",
  );
  const firstBytes = await readFile(firstDownload);
  need(firstBytes.length > 1000, "drawing export empty");
  firstBytes.fill(0);
  await cdp.eval(
    frame(
      "official.drawing",
      `document.querySelector("#gallery .result-actions button").click(),true`,
    ),
  );
  await cdp.wait(
    frame(
      "official.drawing",
      `(()=>({ready:document.querySelector('.mode-tab[data-mode="edit"]')?.classList.contains("is-active")&&/^[0-9a-f-]{36}$/i.test(document.querySelector("#source-reference")?.value||"")}))()`,
    ),
    "drawing edit handoff",
    30000,
  );
  need(
    await cdp.eval(
      frame(
        "official.drawing",
        setter("#prompt", `Add a luminous green network grid ${runId}`),
      ),
    ),
    "drawing edit prompt missing",
  );
  await cdp.eval(
    frame(
      "official.drawing",
      `(()=>{document.querySelector("#steps").value="4";document.querySelector("#size").value="512x512";document.querySelector("#drawing-form").requestSubmit();return true})()`,
    ),
  );
  await cdp.wait(
    frame(
      "official.drawing",
      `(()=>{const img=document.querySelector("#gallery img");return{ready:document.querySelector("#job-status")?.dataset.status==="succeeded"&&Boolean(img?.complete&&img.naturalWidth>0),error:document.querySelector("#result-error")?.textContent||document.querySelector("#form-error")?.textContent||null}})()`,
    ),
    "drawing edit",
    360000,
  );
  await cdp.send("Page.reload", { ignoreCache: false });
  await cdp.wait(
    frame(
      "official.drawing",
      `(()=>{const img=document.querySelector("#gallery img");return{ready:document.querySelector("#job-status")?.dataset.status==="succeeded"&&Boolean(img?.complete&&img.naturalWidth>0)}})()`,
    ),
    "drawing reload",
    60000,
  );
  return {
    key: "drawing-owner",
    account: account.key,
    role: account.role,
    launchable: true,
    experimentalBadge: true,
    generationCompleted: true,
    editCompleted: true,
    exportDownloaded: true,
    reloadRetained: true,
    metadataFieldCount: first.metadata,
    screenshot: await shot(cdp, options.screenshots, "drawing-owner"),
  };
}

function pdf() {
  const stream =
      "BT\n/F1 48 Tf\n72 650 Td\n(TEAM AI BOX) Tj\n0 -88 Td\n/F1 36 Tf\n(PRIVATE OCR TEST 2026) Tj\nET\n",
    objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    ];
  let out = "%PDF-1.4\n%TeamAIBox\n";
  const offsets = [0];
  objects.forEach((v, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${v}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const n of offsets.slice(1))
    out += `${String(n).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
async function ocr(cdp, account, fixture, downloads, runId) {
  const opened = await open(cdp, "/文字识别|Text Recognition/", "official.ocr");
  need(opened.experimental, "OCR experimental badge missing");
  const x = await cdp.send("Runtime.evaluate", {
      expression: frame("official.ocr", `document.querySelector("#file")`),
      returnByValue: false,
    }),
    id = x.result?.objectId;
  need(id, "OCR file input missing");
  await cdp.send("DOM.setFileInputFiles", { files: [fixture], objectId: id });
  await cdp.eval(
    frame(
      "official.ocr",
      `(()=>{const i=document.querySelector("#file");i.dispatchEvent(new Event("change",{bubbles:true}));return i.files?.length===1})()`,
    ),
  );
  await cdp.wait(
    frame(
      "official.ocr",
      `(()=>({ready:document.querySelector("#selected-file")?.hidden===false,name:document.querySelector("#file-name")?.textContent||null,error:document.querySelector("#form-error")?.textContent||null}))()`,
    ),
    "OCR selection",
  );
  await cdp.eval(
    frame("official.ocr", `document.querySelector("#submit").click(),true`),
  );
  await cdp.wait(
    frame(
      "official.ocr",
      `(()=>({ready:document.querySelector("#job")?.hidden===false&&!document.querySelector("#cancel")?.disabled,status:document.querySelector("#status")?.dataset.status||null,error:document.querySelector("#form-error")?.textContent||null}))()`,
    ),
    "OCR queued",
    60000,
  );
  const result = await cdp.wait(
    frame(
      "official.ocr",
      `(()=>({ready:document.querySelector("#status")?.dataset.status==="succeeded"&&document.querySelector("#corrected-text")?.value.length>10,blocks:document.querySelectorAll("#layout .block").length,provenance:document.querySelectorAll("#provenance span").length,text:document.querySelector("#corrected-text")?.value||"",error:document.querySelector("#job-error")?.textContent||null}))()`,
    ),
    "OCR result",
    360000,
  );
  need(
    result.blocks >= 2 &&
      result.provenance >= 2 &&
      /TEAM|PRIVATE|OCR/i.test(result.text),
    "OCR real result incomplete",
  );
  const marker = ` ${runId}-reviewed`;
  await cdp.eval(
    frame(
      "official.ocr",
      `(()=>{const e=document.querySelector("#corrected-text");e.value+=${JSON.stringify(marker)};e.dispatchEvent(new Event("input",{bubbles:true}));return true})()`,
    ),
  );
  const file = await download(
    cdp,
    downloads,
    () =>
      cdp.eval(
        frame("official.ocr", `document.querySelector("#export").click(),true`),
      ),
    "OCR export",
  );
  const bytes = await readFile(file);
  need(bytes.includes(Buffer.from(marker)), "OCR export omitted correction");
  bytes.fill(0);
  await cdp.send("Page.reload", { ignoreCache: false });
  await cdp.wait(
    frame(
      "official.ocr",
      `(()=>({ready:document.querySelector("#status")?.dataset.status==="succeeded"&&document.querySelector("#corrected-text")?.value.length>10}))()`,
    ),
    "OCR reload",
    60000,
  );
  return {
    key: "ocr-ordinary-user",
    account: account.key,
    role: account.role,
    launchable: true,
    experimentalBadge: true,
    fileSelected: true,
    recognitionCompleted: true,
    layoutBlockCount: result.blocks,
    correctionApplied: true,
    exportDownloaded: true,
    reloadRetained: true,
    translationHandoffCompleted: false,
    screenshot: await shot(cdp, options.screenshots, "ocr-ordinary-user"),
  };
}

const options = args(process.argv.slice(2));
async function main() {
  const accounts = await credentials();
  await readFile(options.output)
    .then(() => {
      throw new BrowserSmokeError("evidence exists");
    })
    .catch((e) => {
      if (e instanceof BrowserSmokeError) throw e;
      if (e.code !== "ENOENT") throw e;
    });
  const deploymentBytes = await readFile(options.deploymentEvidence),
    deployment = JSON.parse(deploymentBytes),
    identity = deployment.runId?.match(
      /^[a-z0-9-]+-(20[0-9]{6})-([a-z0-9][a-z0-9-]{1,63})$/,
    );
  need(identity, "deployment identity invalid");
  const plan = JSON.parse(
      await readFile(
        join(
          ROOT,
          "deploy",
          "application-catalog-e2e",
          `plan-${identity[1]}-${identity[2]}.json`,
        ),
      ),
    ),
    builtImages = Object.fromEntries(
      (deployment.imageBindings ?? []).map((item) => [
        item.component,
        item.imageId,
      ]),
    ),
    webImageId =
      builtImages["catalog-web"] ??
      plan.environment?.TEAMAIBOX_CATALOG_WEB_IMAGE,
    drawingImageId =
      builtImages["catalog-drawing"] ??
      plan.environment?.TEAMAIBOX_CATALOG_DRAWING_IMAGE,
    ocrImageId =
      builtImages["catalog-ocr"] ??
      plan.environment?.TEAMAIBOX_CATALOG_OCR_IMAGE;
  need(
    deployment.status === "passed" &&
      [webImageId, drawingImageId, ocrImageId].every((x) =>
        SHA.test(x ?? ""),
      ) &&
      ["drawing-plugin", "ocr-plugin"].every((service) =>
        plan.featureServices?.includes(service),
      ),
    "deployment binding invalid",
  );
  await mkdir(dirname(options.output), { recursive: true });
  await mkdir(options.screenshots, { recursive: false });
  const profile = await mkdtemp(
      join(tmpdir(), "teamaibox-drawing-ocr-browser-"),
    ),
    downloads = join(profile, "downloads");
  await mkdir(downloads);
  const fixture = join(profile, "ocr-validation.pdf"),
    pdfBytes = pdf(),
    fixtureDigest = digest(pdfBytes);
  await writeFile(fixture, pdfBytes);
  pdfBytes.fill(0);
  const p = await port(),
    chrome = spawn(
      options.chrome,
      [
        "--headless=new",
        `--remote-debugging-port=${p}`,
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--metrics-recording-only",
        "--ignore-certificate-errors",
        "--window-size=1440,900",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
  const startedAt = new Date().toISOString(),
    journeys = [],
    errors = [];
  let cdp,
    browser = null,
    failure = null;
  try {
    const targets = await waitJson(`http://127.0.0.1:${p}/json/list`),
      target = targets.find((x) => x.type === "page");
    need(target?.webSocketDebuggerUrl, "Chrome target missing");
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    cdp.on("Runtime.exceptionThrown", (e) =>
      errors.push(
        String(
          e.exceptionDetails?.exception?.description ??
            e.exceptionDetails?.text ??
            "exception",
        ).slice(0, 300),
      ),
    );
    cdp.on("Runtime.consoleAPICalled", (e) => {
      if (e.type === "error")
        errors.push(
          String(e.args?.[0]?.value ?? "console error").slice(0, 300),
        );
    });
    await Promise.all([
      cdp.send("Page.enable"),
      cdp.send("Runtime.enable"),
      cdp.send("Network.enable"),
      cdp.send("DOM.enable"),
      cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      }),
      cdp.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: downloads,
        eventsEnabled: true,
      }),
    ]);
    browser = await cdp.eval(
      `({userAgent:navigator.userAgent,platform:navigator.platform})`,
    );
    await signIn(cdp, options.origin, accounts[0]);
    journeys.push(await drawing(cdp, accounts[0], downloads, options.runId));
    await signIn(cdp, options.origin, accounts[1]);
    journeys.push(
      await ocr(cdp, accounts[1], fixture, downloads, options.runId),
    );
    need(errors.length === 0, `browser emitted ${errors.length} error events`);
  } catch (e) {
    failure = {
      type: e?.constructor?.name ?? "Error",
      message: String(e?.message ?? e).slice(0, 400),
    };
  } finally {
    cdp?.close();
    chrome.kill("SIGTERM");
    await Promise.race([
      new Promise((r) => chrome.once("exit", r)),
      sleep(3000),
    ]);
    await rm(profile, { recursive: true, force: true });
    for (const a of accounts) a.value.password = "[REDACTED]";
  }
  const evidence = {
    schemaVersion: 1,
    runnerId: "teamaibox.drawing-ocr-browser-smoke.v1",
    runId: options.runId,
    featureKeys: ["official.drawing", "official.ocr"],
    status: failure ? "failed" : "passed",
    classification: "component-canary-self-signed-https",
    releaseEvidenceEligible: false,
    origin: options.origin,
    startedAt,
    completedAt: new Date().toISOString(),
    browser,
    journeys,
    console: { errorCount: errors.length },
    source: {
      runnerDigest: digest(await readFile(new URL(import.meta.url))),
      ocrFixtureDigest: fixtureDigest,
    },
    deployment: {
      evidencePath: relative(ROOT, options.deploymentEvidence),
      evidenceDigest: digest(deploymentBytes),
      runId: deployment.runId,
      webImageId,
      drawingImageId,
      ocrImageId,
    },
    privacy: {
      credentialsRetained: false,
      userContentRetained: false,
      syntheticScreenshotsRetained: true,
      commandOutputRetained: false,
      syntheticContentOnly: true,
    },
    limitations: { translationHandoff: "not_exercised_in_this_runner" },
    failure,
  };
  evidence.evidenceDigest = digest(canonical(evidence));
  await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: "wx",
  });
  if (failure)
    throw new BrowserSmokeError(
      `drawing/OCR browser smoke failed; evidence: ${relative(ROOT, options.output)}`,
    );
  process.stdout.write(
    `${JSON.stringify({ runId: evidence.runId, status: evidence.status, journeyCount: journeys.length, evidence: relative(ROOT, options.output) })}\n`,
  );
}
main().catch((e) => {
  process.stderr.write(`${e?.message ?? "browser smoke failed"}\n`);
  process.exitCode = 1;
});
