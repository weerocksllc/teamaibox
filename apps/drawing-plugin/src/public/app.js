import {applyProductLabels} from './product-localization.mjs';
import { localizedCatalogs, normalizeProductLocale, productLocaleDirection } from "./product-localization.mjs";
import { applyPluginPreferenceSnapshotV1, subscribePluginPreferenceMessagesV1 } from "./preferences-v1.mjs";
import { parseDrawingIntentRouterV2, preferredDrawingIntentV2 } from "./intent-router-client-v2.mjs";

const focusStylesheet = document.createElement("link");
focusStylesheet.rel = "stylesheet";
focusStylesheet.href = new URL("./focus.css", import.meta.url).href;
document.head.append(focusStylesheet);
subscribePluginPreferenceMessagesV1({ currentWindow: window, hostWindow: parent, hostOrigin: location.origin,
  onChange: snapshot => applyPluginPreferenceSnapshotV1({ currentDocument: document, snapshot }) });

const PLUGIN_ID = "official.drawing";
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired", "incomplete"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_OBJECT_PATH = /^\/api\/v1\/objects\/references\/[0-9a-f-]{36}\/content(?:\?download=1)?$/i;
const JOB_STORAGE_KEY = "teamaibox.drawing.current-job.v1";

const messages = localizedCatalogs({
  "zh-CN": {
    eyebrow: "AI 创作空间", title: "AI 绘图", subtitle: "描述想要的画面，选择创作方式，生成属于你的图片。",
    encrypted: "加密存储", validating: "验证中模型", chooseIntent: "选择创作意图", intentGroup: "绘图意图",
    intentAutomatic: "自动", intentAutomaticHint: "自动选择当前可用模型", intentFast: "快速", intentFastHint: "优先低延迟预览", available: "可用", unavailable: "暂不可用", checking: "检查中",
    no_automatic_profile: "暂无可用模型", no_fast_profile: "快速绘图尚未就绪", protected_office_profile_unavailable: "本机办公绘图服务暂不可用，请稍后重试。", not_qualified: "尚未通过验证",
    activeProfile: "当前模型", routeLocal: "本机算力", certificationValidating: "Validating", certificationCertified: "Certified", exclusive: "独占加载",
    prompt: "画面描述", promptPlaceholder: "描述主体、场景、光线、材质与风格…",
    outputSettings: "输出设置", aspectGroup: "画面比例", square: "方形", landscape: "横版", portrait: "竖版", size: "尺寸", count: "数量",
    seed: "随机种子", format: "格式", executionFacts: "参数与支持范围", steps: "采样步数", guidance: "提示词引导",
    fluxBoundary: "当前模型固定使用 4 步、引导值 1，暂不支持负面提示词和局部重绘。",
    profileBoundary: "当前模型固定使用 {steps} 步、引导值 {guidance}；其余可用参数可在下方调整。",
    submit: "开始生成", queueHint: "提交后可查看生成进度。服务正在恢复时，任务会排队等待。",
    emptyTitle: "在这里预览创作结果", emptyBody: "描述想要的图片并开始生成，完成后可查看、下载或继续编辑。",
    currentJob: "当前任务", cancel: "取消", export: "导出", stored: "已加密保存", metadata: "生成详情", preset: "意图预设", profile: "使用的模型",
    fingerprint: "档案指纹", engine: "引擎镜像", requestDigest: "请求摘要", completedAt: "完成时间", route: "实际路由",
    preparing: "正在准备绘图模型", queued: "等待处理", admitted: "已接受任务", running: "正在生成", succeeded: "生成完成", failed: "生成失败",
    cancelled: "任务已取消", expired: "任务已过期", incomplete: "任务未完整完成", pollDetail: "任务 {id} · 状态会自动更新",
    cancelPending: "正在取消任务…", submitFailed: "无法提交绘图任务。", sessionRequired: "登录已过期，请重新登录。",
    profileUnavailable: "当前创作方式暂无可用模型，请选择标记为“可用”的选项。", routerUnavailable: "暂时无法获取绘图选项，请稍后重试或联系管理员。", resultInvalid: "任务完成，但结果格式无法验证。",
  },
  en: {
    eyebrow: "AI CREATIVE STUDIO", title: "AI Drawing", subtitle: "Describe your image, choose a creative approach, and bring it to life.",
    encrypted: "Encrypted storage", validating: "Validating model", chooseIntent: "Choose creative intent", intentGroup: "Drawing intents",
    intentAutomatic: "Automatic", intentAutomaticHint: "Choose an available model automatically", intentFast: "Fast", intentFastHint: "Prioritize preview latency", available: "Available", unavailable: "Unavailable", checking: "Checking",
    no_automatic_profile: "No model available", no_fast_profile: "Fast generation is not ready", protected_office_profile_unavailable: "The local Drawing service is unavailable. Please retry shortly.", not_qualified: "Not yet validated",
    activeProfile: "Current model", routeLocal: "Local compute", certificationValidating: "Validating", certificationCertified: "Certified", exclusive: "Exclusive load",
    prompt: "Prompt", promptPlaceholder: "Describe the subject, scene, lighting, materials, and style…",
    outputSettings: "Output settings", aspectGroup: "Aspect ratio", square: "Square", landscape: "Landscape", portrait: "Portrait", size: "Size", count: "Count",
    seed: "Seed", format: "Format", executionFacts: "Parameters and supported features", steps: "Sampling steps", guidance: "Prompt guidance",
    fluxBoundary: "This model uses 4 steps and guidance 1. Negative prompts and local inpainting are not supported.",
    profileBoundary: "This model uses {steps} steps and guidance {guidance}. Other available parameters can be adjusted below.",
    submit: "Generate image", queueHint: "Track progress after submitting. Tasks wait in the queue while the service recovers.",
    emptyTitle: "Your result will appear here", emptyBody: "Describe an image and start generating. View, download, or edit the result when it is ready.",
    currentJob: "CURRENT JOB", cancel: "Cancel", export: "Export", stored: "Encrypted and saved", metadata: "Generation details", preset: "Intent preset", profile: "Model used",
    fingerprint: "Profile fingerprint", engine: "Engine image", requestDigest: "Request digest", completedAt: "Completed at", route: "Actual route",
    preparing: "Preparing drawing model", queued: "Queued", admitted: "Job admitted", running: "Generating", succeeded: "Generation complete", failed: "Generation failed",
    cancelled: "Job cancelled", expired: "Job expired", incomplete: "Job incomplete", pollDetail: "Job {id} · status updates automatically",
    cancelPending: "Cancelling job…", submitFailed: "Unable to submit the drawing job.", sessionRequired: "Your secure session has expired. Sign in again.",
    profileUnavailable: "No model is available for this approach. Choose an option marked Available.", routerUnavailable: "Drawing options are unavailable. Try again shortly or contact an administrator.", resultInvalid: "The job completed, but its result could not be verified.",
  },
});

messages.en.random = 'Random'; messages['zh-CN'].random = '随机';
const state = {
  locale: normalizeProductLocale(new URLSearchParams(location.search).get("locale")),
  theme: new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark",
  router: null, intentKey: null,
  jobId: (() => { try { const value = sessionStorage.getItem(JOB_STORAGE_KEY); return UUID.test(value || "") ? value : null; } catch { return null; } })(),
  pollTimer: null,
};

const $ = (selector) => document.querySelector(selector);
const t = (key, values = {}) => {
  let value = messages[state.locale]?.[key] || messages["zh-CN"][key] || key;
  for (const [name, replacement] of Object.entries(values)) value = value.replace(`{${name}}`, String(replacement));
  return value;
};
const intent = () => state.router?.intents.find((item) => item.intentKey === state.intentKey) ?? null;

function applyPreferences() {
  document.documentElement.lang=state.locale;applyProductLabels(document,state.locale);
  document.documentElement.dir = productLocaleDirection(state.locale);
  document.documentElement.dataset.theme = state.theme;
  for (const element of document.querySelectorAll("[data-i18n]")) element.textContent = t(element.dataset.i18n);
  for (const element of document.querySelectorAll("[data-i18n-placeholder]")) element.placeholder = t(element.dataset.i18nPlaceholder);
  for (const element of document.querySelectorAll("[data-i18n-aria]")) element.setAttribute("aria-label", t(element.dataset.i18nAria));
  if (state.jobId && $("#job-status").dataset.status) $("#job-status").textContent = t($("#job-status").dataset.status);
  if (state.jobId) $("#job-detail").textContent = t("pollDetail", { id: state.jobId.slice(0, 8) });
  renderIntentCards();
  renderDisclosure();
}

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.source !== parent) return;
  const snapshot = event.data;
  if (snapshot?.type !== "teamaibox.plugin-preferences/v1" || snapshot.pluginId !== PLUGIN_ID || snapshot.schemaVersion !== 1) return;
  state.locale = normalizeProductLocale(snapshot.effective?.locale);
  state.theme = snapshot.effective?.theme === "light" ? "light" : "dark";
  applyPreferences();
});

function csrfToken() {
  const matches = document.cookie.split(";").map((part) => part.trim()).filter((part) => part.startsWith("__Host-teamaibox-csrf="));
  if (matches.length !== 1) throw Object.assign(new Error(t("sessionRequired")), { code: "csrf_unavailable" });
  return matches[0].slice(matches[0].indexOf("=") + 1);
}

async function request(path, { method = "GET", body = null, idempotencyKey = null } = {}) {
  const headers = { accept: "application/json" };
  if (body !== null) { headers["content-type"] = "application/json"; headers["x-csrf-token"] = csrfToken(); }
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const response = await fetch(path, { method, credentials: "same-origin", headers,
    body: body === null ? undefined : JSON.stringify(body) });
  let value = null;
  try { value = await response.json(); } catch { /* handled below */ }
  if (!response.ok) {
    const code = value?.error?.code || "request_failed";
    const unavailable = new Set(["capability_unavailable", "model_profile_unavailable", "no_eligible_worker", "admission_rejected", "compute_route_unavailable"]);
    throw Object.assign(new Error(unavailable.has(code) ? t("profileUnavailable") : (value?.error?.message || t("submitFailed"))), { code, status: response.status });
  }
  return value;
}

function showError(element, message) { element.textContent = message; element.hidden = !message; }

function reason(item) { return t(item?.reasonCode || "unavailable"); }

function renderIntentCards() {
  for (const card of document.querySelectorAll(".intent-card")) {
    const item = state.router?.intents.find((candidate) => candidate.intentKey === card.dataset.intent);
    const selected = item?.intentKey === state.intentKey;
    card.disabled = item?.available !== true;
    card.classList.toggle("is-active", selected);
    card.classList.toggle("is-unavailable", Boolean(item && !item.available));
    card.setAttribute("aria-checked", String(selected));
    const status = card.querySelector("em");
    status.textContent = !item ? t("checking") : item.available ? t("available") : t("unavailable");
    card.title = item && !item.available ? reason(item) : "";
  }
}

function renderDisclosure() {
  const item = intent();
  const disclosure = $("#route-disclosure");
  disclosure.hidden = !item?.available;
  if (!item?.available) { $("#model-tier").hidden = true; return; }
  $("#profile-name").textContent = item.selectedProfileDisplayName;
  $("#profile-key").textContent = item.selectedProfile;
  $("#profile-precision").textContent = String(item.precision || "—").toUpperCase();
  $("#profile-certification").textContent = item.certificationState === "certified" ? t("certificationCertified") : t("certificationValidating");
  $("#profile-route").textContent = t("routeLocal");
  $("#model-tier").hidden = item.certificationState === "certified";
  $("#capability-boundary").textContent = item.selectedProfile === "drawing.flux2-klein-4b.bf16.main-protected.v2"
    ? t("fluxBoundary") : t("profileBoundary", { steps: item.defaults.steps, guidance: item.defaults.guidanceScale });
}

function sizeParts(value) {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(value ?? "");
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function sizeAllowed(value, constraints) {
  const dimensions = sizeParts(value);
  if (!dimensions) return false;
  return dimensions[0] <= (constraints?.maximumWidth ?? Number.MAX_SAFE_INTEGER)
    && dimensions[1] <= (constraints?.maximumHeight ?? Number.MAX_SAFE_INTEGER);
}

function applySizeConstraints(selected) {
  const options = [...$("#size").options];
  for (const option of options) {
    option.disabled = !sizeAllowed(option.value, selected.constraints);
    option.hidden = option.disabled;
  }
  if (!sizeAllowed($("#size").value, selected.constraints)) {
    const fallback = options.find((option) => !option.disabled);
    if (fallback) $("#size").value = fallback.value;
  }
  for (const preset of document.querySelectorAll(".preset")) {
    preset.disabled = !sizeAllowed(preset.dataset.size, selected.constraints);
    const active = !preset.disabled && preset.dataset.size === $("#size").value;
    preset.classList.toggle("is-active", active);
    preset.setAttribute("aria-pressed", String(active));
  }
}

function selectIntent(key, { focus = false } = {}) {
  const selected = state.router?.intents.find((item) => item.intentKey === key);
  if (!selected?.available) return false;
  state.intentKey = key;
  $("#steps").value = String(selected.defaults.steps);
  $("#guidance").value = String(selected.defaults.guidanceScale);
  $("#count").value = String(selected.defaults.count);
  applySizeConstraints(selected);
  $("#submit").disabled = false;
  showError($("#form-error"), "");
  renderIntentCards();
  renderDisclosure();
  if (focus) $("#prompt").focus();
  return true;
}

async function loadIntentRouter() {
  try {
    const catalog = await request("/api/v1/applications");
    const application = catalog?.applications?.find((item) => item.pluginKey === PLUGIN_ID);
    const router = parseDrawingIntentRouterV2(application);
    if (!application?.launchable || !router?.available) throw new Error(t("routerUnavailable"));
    state.router = router;
    const preferred = preferredDrawingIntentV2(router, state.intentKey);
    if (preferred) selectIntent(preferred.intentKey);
    else {
      state.intentKey = null;
      $("#submit").disabled = true;
      renderIntentCards();
      renderDisclosure();
      showError($("#form-error"), t("profileUnavailable"));
    }
  } catch (error) {
    state.router = null;
    state.intentKey = null;
    $("#submit").disabled = true;
    $("#route-disclosure").hidden = true;
    $("#model-tier").hidden = true;
    renderIntentCards();
    showError($("#form-error"), error.message || t("routerUnavailable"));
  }
}

function drawingParameters() {
  const selected = intent();
  const seedRaw = $("#seed").value.trim();
  return { preset_key: `drawing.${selected.intentKey}.v1`,
    seed: seedRaw === "" ? Math.floor(Math.random() * 4_294_967_296) : Number(seedRaw),
    steps: selected.defaults.steps, guidance_scale: selected.defaults.guidanceScale,
    negative_prompt: "", output_format: $("#format").value };
}

async function submissionBody() {
  const selected = intent();
  if (!selected?.available) throw new Error(t("profileUnavailable"));
  if (!sizeAllowed($("#size").value, selected.constraints)) throw new Error(t("profileUnavailable"));
  const parameters = drawingParameters();
  const common = { model: selected.modelAlias, prompt: $("#prompt").value.trim(), n: 1, size: $("#size").value };
  return { ...common, x_teamaibox: { background: true,
    model_profile_id: selected.selectedProfileId, data_class: "internal", priority: 50,
    extensions: { drawing: parameters } } };

}

function jobProgress(status) { return { queued: 8, admitted: 14, preparing: 28, running: 66, succeeded: 100, failed: 100, cancelled: 100, expired: 100, incomplete: 100 }[status] || 5; }

function presentJob(job) {
  $("#empty-state").hidden = true;
  $("#job-view").hidden = false;
  const status = job.status || "queued";
  $("#job-view").ariaBusy = String(!TERMINAL.has(status));
  $("#job-status").dataset.status = status;
  $("#job-status").textContent = t(status);
  $("#progress-bar").style.width = `${jobProgress(status)}%`;
  $("#job-detail").textContent = t("pollDetail", { id: state.jobId.slice(0, 8) });
  $("#cancel-job").disabled = TERMINAL.has(status);
  if (["failed", "incomplete", "expired"].includes(status)) showError($("#result-error"), job.error?.message || t(status));
  else showError($("#result-error"), "");
  if (status === "succeeded") presentResult(job.result);
}

function safePath(value) { return typeof value === "string" && SAFE_OBJECT_PATH.test(value) ? value : null; }

function presentResult(result) {
  if (result?.schema !== "teamaibox.ai.image-result.v1" || !Array.isArray(result.outputs) || result.outputs.length === 0) {
    showError($("#result-error"), t("resultInvalid")); return;
  }
  const gallery = $("#gallery");
  gallery.replaceChildren();
  for (const output of result.outputs) {
    const preview = safePath(output.preview_path), download = safePath(output.download_path);
    if (!preview || !download || output.encrypted !== true) continue;
    const card = document.createElement("article"); card.className = "result-card";
    const image = document.createElement("img"); image.src = preview; image.alt = result.revised_prompt || result.prompt || t("title"); image.loading = "lazy";
    const actions = document.createElement("div"); actions.className = "result-actions";
    const stored = document.createElement("span"); stored.textContent = `◆ ${t("stored")}`;
    const link = document.createElement("a"); link.href = download; link.download = `teamaibox-${result.job_id}.${result.reproducibility?.output_format || "png"}`; link.textContent = t("export");
    actions.append(stored);
    actions.append(link); card.append(image, actions); gallery.append(card);
  }
  const metadata = $("#metadata"); metadata.hidden = false; metadata.replaceChildren();
  const title = document.createElement("summary"); title.textContent = t("metadata");
  const grid = document.createElement("div"); grid.className = "metadata-grid";
  const fields = [["preset", result.reproducibility?.preset_key], ["seed", result.reproducibility?.seed], ["size", result.reproducibility?.size],
    ["steps", result.reproducibility?.steps], ["profile", result.provenance?.profile_key], ["route", result.provenance?.route],
    ["fingerprint", result.provenance?.profile_fingerprint], ["engine", result.provenance?.engine_image_digest],
    ["requestDigest", result.provenance?.request_digest], ["completedAt", result.provenance?.completed_at]];
  for (const [label, value] of fields) {
    const item = document.createElement("div"), name = document.createElement("span"), code = document.createElement("code");
    name.textContent = t(label); code.textContent = String(value ?? "—"); code.title = String(value ?? ""); item.append(name, code); grid.append(item);
  }
  metadata.append(title, grid);
}

async function pollJob() {
  if (!state.jobId) return;
  try {
    const job = await request(`/api/v1/jobs/${state.jobId}`); presentJob(job);
    if (!TERMINAL.has(job.status)) state.pollTimer = setTimeout(pollJob, 1500);
  } catch (error) { showError($("#result-error"), error.message || t("submitFailed")); state.pollTimer = setTimeout(pollJob, 3500); }
}

$("#drawing-form").addEventListener("submit", async (event) => {
  event.preventDefault(); showError($("#form-error"), ""); $("#submit").disabled = true;
  try {
    const body = await submissionBody(), idempotencyKey = `drawing:${crypto.randomUUID()}`;
    const path = "/v1/images/generations";
    const accepted = await request(path, { method: "POST", body, idempotencyKey });
    const jobId = accepted.job_id || accepted.x_teamaibox?.job_id;
    if (!UUID.test(jobId || "")) throw new Error(t("submitFailed"));
    clearTimeout(state.pollTimer); state.jobId = jobId;
    try { sessionStorage.setItem(JOB_STORAGE_KEY, jobId); } catch { /* durable API remains authoritative */ }
    $("#gallery").replaceChildren(); $("#metadata").hidden = true;
    presentJob({ status: accepted.status || accepted.x_teamaibox?.state || "queued" }); await pollJob();
  } catch (error) { showError($("#form-error"), error.message || t("submitFailed")); }
  finally { $("#submit").disabled = !intent()?.available; $("#submit span:last-child").textContent = t("submit"); }
});

$("#cancel-job").addEventListener("click", async () => {
  if (!state.jobId) return;
  $("#cancel-job").disabled = true; $("#job-detail").textContent = t("cancelPending");
  try {
    const job = await request(`/api/v1/jobs/${state.jobId}/cancel`, { method: "POST", body: {} });
    clearTimeout(state.pollTimer); presentJob(job);
    if (!TERMINAL.has(job.status)) state.pollTimer = setTimeout(pollJob, 250);
  } catch (error) { showError($("#result-error"), error.message || t("submitFailed")); }
});

for (const card of document.querySelectorAll(".intent-card")) card.addEventListener("click", () => selectIntent(card.dataset.intent, { focus: true }));
for (const preset of document.querySelectorAll(".preset")) preset.addEventListener("click", () => {
  $("#size").value = preset.dataset.size;
  for (const item of document.querySelectorAll(".preset")) { const active = item === preset; item.classList.toggle("is-active", active); item.setAttribute("aria-pressed", String(active)); }
});
$("#size").addEventListener("change", () => { for (const item of document.querySelectorAll(".preset")) { const active = item.dataset.size === $("#size").value; item.classList.toggle("is-active", active); item.setAttribute("aria-pressed", String(active)); } });

applyPreferences();
await loadIntentRouter();
setInterval(() => { if (!state.jobId || $("#job-view").ariaBusy !== "true") void loadIntentRouter(); }, 15_000);
if (state.jobId) pollJob();
parent.postMessage({ type: "teamaibox.plugin-ready/v1", pluginId: PLUGIN_ID }, location.origin);
