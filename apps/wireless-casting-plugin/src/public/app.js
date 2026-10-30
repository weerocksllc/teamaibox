import {applyProductLabels} from './product-localization.mjs';
import { localizedCatalogs, normalizeProductLocale, productLocaleDirection, productText } from "./product-localization.mjs";
import { applyPluginPreferenceSnapshotV1 } from "/plugins/official.wireless-casting/preferences-v1.mjs";
import {
  browserPlaybackPolicyV1,
  CastingApiError,
  createCastingApiV1,
  fetchCastingJsonV1,
  readCastingSessionV1,
  validateCastingDraftV1,
} from "./casting-client-v1.mjs";
import { createCastingMediaClientV1 } from "./casting-media-client-v1.mjs";
import { createViewingResumeStoreV1 } from "./casting-viewing-resume-v1.mjs";
import { outputHealthLabelV1, workspaceVisibleV1, videoVisibleV1, joinAfterStartV1,
  presentationV1, sourceReconciliationV1 } from "./casting-ui-policy-v1.mjs";

const PLUGIN_ID = "official.wireless-casting";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_STATES = new Set(["requested", "starting", "pairing", "paired", "streaming", "stopping"]);
const query = new URLSearchParams(location.search);

const messages = localizedCatalogs({
  "zh-CN": {
    acceptWatch: "接受并观看", inviteWatchHint: "有人邀请你观看当前投屏。", watchAccepted: "开始观看",
    stateDisconnected: "设备已断开",
    more: "分享与设置", unmute: "打开声音", sourceDisconnected: "设备已断开，等待重新连接。接收器仍然可用。",
    playbackGesture: "请点击画面中的播放按钮", playbackFailed: "播放未能继续，请离开观看后重新加入",
    outputBlocked: "浏览器投屏暂不可用，请稍后重试。", healthWaiting: "等待设备发送画面", errorMediaClient: "浏览器播放器加载失败，请刷新页面后重新加入。",
    eyebrow: "团队演示", title: "无线投屏", subtitle: "把 Apple 设备的画面和声音投到网页，或邀请同事一起观看。",
    checking: "正在检查", serviceReady: "投屏服务可用", serviceUnavailable: "投屏服务不可用", serviceUnsupported: "暂未就绪",
    retryConnection: "重新连接", requestTimeout: "服务响应超时。请重新连接确认当前状态；操作不会自动重复提交。",
    availabilityTitle: "投屏准备进度", availabilityUnsupported: "投屏暂未开启",
    availabilitySummary: "投屏服务尚未就绪，Apple 设备暂时无法找到接收器。请检查下方提示。",
    receiverNotReady: "接收器未就绪", sessionStartBlocked: "暂不能开始投屏", gateBlocked: "待完成",
    gateCategory_legal: "法律", gateCategory_supply_chain: "供应链", gateCategory_hardware: "硬件", gateCategory_runtime: "运行时", gateCategory_security: "安全",
    airplay_supply_chain_human_decisions_pending: "兼容 AirPlay 的来源、分发和商标决策尚未获得人工批准。",
    trusted_media_arm64_image_unbuilt: "可信媒体服务的 ARM64 镜像尚未构建。",
    final_sbom_signature_provenance_and_vulnerability_evidence_missing: "最终 SBOM、签名、来源证明和漏洞接受材料缺失。",
    h264_encoder_plugin_missing: "H.264 编码插件缺失。",
    webrtc_plugin_missing: "WebRTC 插件缺失。", physical_apple_sender_not_exercised: "尚未使用真实 Apple 发送设备验证。",
    seccomp_and_apparmor_real_runtime_not_exercised: "投屏服务的配置检查尚未完成，请联系管理员。",
    casting_runtime_admission_not_configured: "可信媒体运行时尚未通过显式启用准入，接收器保持关闭。",
    casting_product_service_not_deployed: "网页还没有接通实际投屏接收服务。",
    configureTitle: "投屏设置", newSession: "新会话", updateSession: "调整当前会话", outputsLegend: "输出位置（可多选）",
    browserTitle: "当前浏览器", browserHint: "在网页中观看画面和声音，无需连接显示器。",
    audienceLegend: "谁可以在浏览器观看", audienceOwner: "仅自己", audienceOwnerHint: "管理员也需要邀请才能观看",
    audienceUsers: "指定用户", audienceUsersHint: "只邀请你明确选择的用户", audienceTeam: "指定团队", audienceTeamHint: "加入时会再次检查当前团队成员关系",
    selectUsers: "选择用户", directoryEmpty: "当前没有可邀请的用户。", selectTeam: "选择团队", chooseTeam: "请选择团队",
    teamIdLabel: "或输入团队 ID", teamIdPlaceholder: "00000000-0000-4000-8000-000000000000", teamRecheck: "平台会在接受邀请和每次加入时重新核验团队成员关系。",
    duration: "接收器有效时间", durationHint: "到期后自动结束投屏", minutes15: "15 分钟", minutes30: "30 分钟", minutes60: "60 分钟", minutes120: "2 小时",
    start: "开始接收", update: "应用观看范围", startHint: "开始后，iPhone、iPad 或 Mac 仍需选择临时接收器并输入 PIN。",
    sessionTitle: "当前投屏", refresh: "刷新", loading: "正在读取会话…", noSession: "当前没有可见投屏会话",
    noSessionHint: "有权限的用户可以在上方创建临时接收器；受邀用户会在邀请区域看到通知。", stateLabel: "会话状态", expires: "到期时间", viewerCount: "观看人数",
    receiverName: "临时接收器名称", receiverPin: "随机 PIN", pairStep1: "在 Apple 设备打开屏幕镜像。", pairStep2: "选择上方临时名称并输入 PIN。", pairStep3: "PIN 和名称仅在本次会话内有效。",
    sourceDevice: "已配对来源", ephemeral: "临时显示，不保存、不审计", outputHealth: "输出健康", receiverHealthy: "接收器正常", receiverUnhealthy: "接收器异常", receiverUnknown: "接收器状态未知",
    viewingRemoved: "发起者已将你移出本次观看。", viewingEnded: "本次投屏已结束。", viewingDisconnected: "观看连接已中断，请按页面提示重新连接。",
    outputBrowser: "浏览器", healthAvailable: "可用", healthUnavailable: "不可用", healthUnknown: "未知",
    browserPlayback: "浏览器观看", notJoined: "尚未加入", joined: "已连接", connectingMedia: "正在建立加密连接", waitingMedia: "等待投屏画面", reconnectMedia: "连接已中断，请重新加入", explicitJoin: "点击“加入观看”，在此浏览器接收画面和声音。",
    mediaBoundary: "退出观看不会结束投屏。", inviteRequired: "请先接受当前会话的有效邀请，再明确加入观看。",
    join: "加入观看", leave: "离开观看", stop: "停止投屏", forceStop: "管理员强制停止", managerBoundary: "你可以查看服务状态或停止投屏。观看画面需要邀请；投屏码和来源设备仅对有权限的用户显示。",
    invitations: "观看邀请", noInvitations: "没有待处理的邀请。", invitationPending: "等待你的决定", invitationAccepted: "已接受；仍需明确加入", invitationDeclined: "已拒绝", invitationExpired: "已失效", invitationRevoked: "已撤销",
    accept: "接受", decline: "拒绝", invitePeople: "邀请观看者", maxViewers: "观看人数按可用资源决定", inviteeLabel: "选择当前观看范围内的用户", chooseUser: "请选择用户", sendInvitation: "发送邀请", inviteNoAutoplay: "对方会在工作台顶部收到提醒；点击“接受并观看”后才会播放。",
    viewers: "实时观看者", noViewers: "还没有浏览器观看者。", you: "你", remove: "移除", joinedAt: "加入于 {time}",
    limitations: "使用范围与限制", limitLan: "发送设备与主盒需要位于已支持的同一局域网。", limitEnvelope: "当前接收一个投屏来源，可邀请有权限的用户观看；流畅度取决于网络和盒子的可用资源。",
    limitNoRecording: "默认不录制画面和声音，不保存投屏码或来源设备名称。", limitDrm: "不支持 FairPlay/DRM 受保护内容。", limitTrademark: "这是兼容 AirPlay 的功能，不代表 Apple 认证。",
    stateRequested: "已请求", stateStarting: "正在启动", statePairing: "等待设备配对", statePaired: "已配对", stateStreaming: "正在投屏", stateStopping: "正在停止", stateStopped: "已停止", stateExpired: "已到期", stateFailed: "失败",
    started: "临时接收器已启动。", updated: "输出与观看范围已更新，旧的浏览器授权已撤销。", stopped: "投屏会话已停止。", forceStopped: "投屏会话已由管理员强制停止。",
    invitationSent: "邀请已发送，对方可从工作台顶部或通知铃铛打开。", invitationAcceptedNotice: "邀请已接受。", invitationDeclinedNotice: "邀请已拒绝。",
    joinedNotice: "浏览器已准备好，设备投屏后会自动显示画面。", leftNotice: "已离开浏览器观看。", viewerRemoved: "观看者已移除。",
    permissionUse: "当前账户不能发起投屏，但仍可处理收到的观看邀请。", permissionNone: "当前账户没有无线投屏使用、观看或管理权限。",
    directoryUnavailable: "用户目录暂时不可用，指定用户模式已关闭。", teamDirectoryUnavailable: "团队目录不可用；具有分享权限时可填写精确团队 ID。",
    errorOutput: "投屏仅支持浏览器观看。", errorAudience: "请选择有效的浏览器观看范围。", errorUsers: "指定用户模式至少需要选择一名其他用户。", errorTeam: "请输入或选择一个有效的团队 ID。",
    errorShare: "当前账户没有共享投屏权限，只能选择仅自己。", errorView: "当前账户没有浏览器观看权限。", errorBusy: "主盒已有一个活动投屏会话，请等待其结束或由有权限的管理员处理。",
    errorUnavailable: "无线投屏能力尚未就绪，所有开始和加入操作已关闭。", errorNetwork: "无法连接投屏服务，请刷新后确认当前状态。",
    errorSession: "登录已过期，请重新登录。", errorConflict: "会话状态已经变化，请刷新后重试。", errorInvite: "邀请无效、已过期或已被撤销。", errorGeneric: "操作未完成，请刷新状态后重试。",
    errorOutputRestart: "新增输出前，请先停止投屏，再选择需要的输出并重新开始。",
    errorCleanup: "投屏服务还在停止，请稍候。确认停止前不会启动新的投屏。",
    errorOffice: "当前可用资源不足，暂时无法开始投屏。请等待正在处理的任务完成后重试。",
  },
  en: {
    acceptWatch: "Accept & watch", inviteWatchHint: "You're invited to watch the current cast.", watchAccepted: "Watch now",
    stateDisconnected: "Device disconnected",
    more: "Sharing and settings", unmute: "Turn sound on", sourceDisconnected: "Device disconnected. The receiver is still available for reconnection.",
    playbackGesture: "Select the play button in the video", playbackFailed: "Playback stopped. Leave viewing and join again",
    outputBlocked: "Browser casting is temporarily unavailable. Try again later.", healthWaiting: "Waiting for sender media", errorMediaClient: "The browser player did not load. Refresh the page and join again.",
    eyebrow: "TEAM PRESENTATION", title: "Wireless Casting", subtitle: "Cast your Apple device to the browser or invite colleagues to watch.",
    checking: "Checking", serviceReady: "Casting service ready", serviceUnavailable: "Casting service unavailable", serviceUnsupported: "Unsupported here",
    retryConnection: "Reconnect", requestTimeout: "The service did not respond in time. Reconnect to check current state; actions are never automatically resubmitted.",
    availabilityTitle: "Casting setup progress", availabilityUnsupported: "Casting is not enabled yet",
    availabilitySummary: "Casting is not ready, so Apple devices cannot find the receiver yet. Review the details below.",
    receiverNotReady: "Receiver not ready", sessionStartBlocked: "New sessions blocked", gateBlocked: "Blocked",
    gateCategory_legal: "Legal", gateCategory_supply_chain: "Supply chain", gateCategory_hardware: "Hardware", gateCategory_runtime: "Runtime", gateCategory_security: "Security",
    airplay_supply_chain_human_decisions_pending: "AirPlay-compatible source, distribution, and trademark decisions still require accountable human approval.",
    trusted_media_arm64_image_unbuilt: "The casting service has not been installed. Contact an administrator.",
    final_sbom_signature_provenance_and_vulnerability_evidence_missing: "Final SBOM, signature, provenance, and vulnerability acceptance evidence is missing.",
    h264_encoder_plugin_missing: "The H.264 encoder plugin is missing.",
    webrtc_plugin_missing: "The WebRTC plugin is missing.", physical_apple_sender_not_exercised: "No real Apple sender has been exercised.",
    seccomp_and_apparmor_real_runtime_not_exercised: "Casting service configuration checks are incomplete. Contact an administrator.",
    casting_runtime_admission_not_configured: "Trusted media runtime admission is not explicitly enabled, so the receiver remains off.",
    casting_product_service_not_deployed: "The page is not connected to the casting receiver yet.",
    configureTitle: "Casting settings", newSession: "New session", updateSession: "Adjust current session", outputsLegend: "Output destinations (choose one or both)",
    browserTitle: "Current browser", browserHint: "Watch video and audio in your browser. No monitor is required.",
    audienceLegend: "Who may watch in a browser", audienceOwner: "Session initiator only", audienceOwnerHint: "The platform Owner role does not automatically grant viewing",
    audienceUsers: "Selected users", audienceUsersHint: "Invite only users you explicitly select", audienceTeam: "Selected team", audienceTeamHint: "Current team membership is checked again on join",
    selectUsers: "Select users", directoryEmpty: "There are no users available to invite.", selectTeam: "Select a team", chooseTeam: "Choose a team",
    teamIdLabel: "Or enter a team ID", teamIdPlaceholder: "00000000-0000-4000-8000-000000000000", teamRecheck: "The platform rechecks team membership when an invitation is accepted and on every join.",
    duration: "Receiver lifetime", durationHint: "The session stops and temporary credentials are revoked at expiry", minutes15: "15 minutes", minutes30: "30 minutes", minutes60: "60 minutes", minutes120: "2 hours",
    start: "Start receiver", update: "Apply audience", startHint: "After starting, the iPhone, iPad, or Mac must still select the temporary receiver and enter its PIN.",
    sessionTitle: "Current cast", refresh: "Refresh", loading: "Loading session…", noSession: "No visible casting session",
    noSessionHint: "An authorized user can create a temporary receiver above. Invitations appear in the invitation panel.", stateLabel: "Session state", expires: "Expires", viewerCount: "Viewers",
    receiverName: "Temporary receiver name", receiverPin: "Random PIN", pairStep1: "Open Screen Mirroring on the Apple device.", pairStep2: "Choose the temporary name above and enter the PIN.", pairStep3: "The PIN and name are valid only for this session.",
    sourceDevice: "Paired source", ephemeral: "Shown temporarily; never stored or audited", outputHealth: "Output health", receiverHealthy: "Receiver healthy", receiverUnhealthy: "Receiver unhealthy", receiverUnknown: "Receiver health unknown",
    viewingRemoved: "The sender removed you from this viewing session.", viewingEnded: "This casting session has ended.", viewingDisconnected: "The viewing connection was interrupted. Follow the page controls to reconnect.",
    outputBrowser: "Browser", healthAvailable: "Available", healthUnavailable: "Unavailable", healthUnknown: "Unknown",
    browserPlayback: "Browser viewing", notJoined: "Not joined", joined: "Connected", connectingMedia: "Establishing encrypted connection", waitingMedia: "Waiting for cast media", reconnectMedia: "Connection ended; join again", explicitJoin: "Select Join to watch and listen in this browser.",
    mediaBoundary: "Leaving the viewer does not end the casting session.", inviteRequired: "Accept a current invitation first, then explicitly join.",
    join: "Join viewing", leave: "Leave viewing", stop: "Stop casting", forceStop: "Administrator force stop", managerBoundary: "You have management access only: you may view redacted health and force-stop, but may not silently watch or see the PIN or source device.",
    invitations: "Viewing invitations", noInvitations: "No invitations need attention.", invitationPending: "Waiting for your decision", invitationAccepted: "Accepted; explicit join still required", invitationDeclined: "Declined", invitationExpired: "Expired", invitationRevoked: "Revoked",
    accept: "Accept", decline: "Decline", invitePeople: "Invite viewers", maxViewers: "Viewer capacity depends on available resources", inviteeLabel: "Choose a user in the current audience", chooseUser: "Choose a user", sendInvitation: "Send invitation", inviteNoAutoplay: "The recipient sees a workbench notice. Playback starts only after selecting Accept & watch.",
    viewers: "Live viewers", noViewers: "No browser viewers have joined.", you: "You", remove: "Remove", joinedAt: "Joined {time}",
    limitations: "Scope and limitations", limitLan: "The sender and main box must be on the supported same local network.", limitEnvelope: "Receive one source and invite authorized viewers. Playback performance depends on network and available box resources.",
    limitNoRecording: "Recording is off by default. Video, audio, PINs, and source labels are not written to object storage.", limitDrm: "FairPlay/DRM-protected content is unsupported.", limitTrademark: "This is AirPlay-compatible functionality, not Apple certification.",
    stateRequested: "Requested", stateStarting: "Starting", statePairing: "Waiting for pairing", statePaired: "Paired", stateStreaming: "Casting", stateStopping: "Stopping", stateStopped: "Stopped", stateExpired: "Expired", stateFailed: "Failed",
    started: "The temporary receiver has started.", updated: "Outputs and audience were updated. Previous browser authorization was revoked.", stopped: "The casting session has stopped.", forceStopped: "An administrator force-stopped the casting session.",
    invitationSent: "Invitation sent. Open it from the workbench or notification bell.", invitationAcceptedNotice: "Invitation accepted.", invitationDeclinedNotice: "Invitation declined.",
    joinedNotice: "Ready to view. Your screen will appear when the device starts casting.", leftNotice: "You left browser viewing.", viewerRemoved: "Viewer removed.",
    permissionUse: "This account cannot start casting, but may still respond to viewing invitations.", permissionNone: "This account has no wireless casting use, viewing, or management permission.",
    directoryUnavailable: "The user directory is unavailable, so Selected users is disabled.", teamDirectoryUnavailable: "The team directory is unavailable. Users with sharing permission may enter an exact team ID.",
    errorOutput: "Casting is available only in the browser.", errorAudience: "Choose a valid browser audience.", errorUsers: "Selected users requires at least one other user.", errorTeam: "Enter or choose a valid team ID.",
    errorShare: "This account cannot share casting; choose Session initiator only.", errorView: "This account has no browser viewing permission.", errorBusy: "The main box already has an active casting session. Wait for it to end or ask an authorized administrator to act.",
    errorUnavailable: "Wireless casting is not ready. Start and join actions remain disabled.", errorNetwork: "The casting control service could not be reached. No action was performed.",
    errorSession: "Your session expired. Sign in again.", errorConflict: "The session changed. Refresh and try again.", errorInvite: "The invitation is invalid, expired, or revoked.", errorGeneric: "The operation did not complete. Refresh the status and try again.",
    errorOutputRestart: "Stop casting before adding another output, then select the outputs and start again.",
    errorCleanup: "The receiver is still stopping. A new session cannot start until cleanup is confirmed.",
    errorOffice: "Casting cannot currently start alongside the office models. Try again later; office models will not be unloaded for casting.",
  },
});

const state = {
  locale: normalizeProductLocale(query.get("locale")),
  theme: query.get("theme") === "light" ? "light" : "dark",
  ready: false,
  capabilityReady: false,
  availability: null,
  loading: true,
  refreshing: false,
  mutationRevision: 0,
  bootstrapping: false,
  busy: false,
  actorIdentityId: null,
  permissions: new Set(),
  directory: [],
  directoryReady: false,
  teams: [],
  session: null,
  invitations: [],
  acceptedInvitations: new Map(),
  viewers: [],
  selectedUserIds: new Set(),
  draftSessionId: null,
  draftAudience: "owner_only",
  noticeTimer: null,
  layoutSessionId: null,
  streamedSessionId: null,
  sourceStateSessionId: null,
  sourceStateRevision: null,
  availabilityCheckedAt: 0,
  viewerDisconnect: null,
};

const api = createCastingApiV1();
const mediaClient = createCastingMediaClientV1();
const viewingResume = createViewingResumeStoreV1();
let resumeAttempted = false;
const browserInstanceId = `cast-browser:${crypto.randomUUID()}`;
let mediaCredential = null;
let mediaSessionId = null;
let mediaAudienceRevision = null;
let mediaConnectionState = "disconnected";
let pollTimer = null;

const $ = (selector) => document.querySelector(selector);
const t = (key, values = {}) => {
  let value = messages[state.locale]?.[key] ?? messages["zh-CN"][key] ?? key;
  for (const [name, replacement] of Object.entries(values)) value = value.replace(`{${name}}`, String(replacement));
  return value;
};
const can = (permission) => state.permissions.has(permission);

function applyTranslations() {
  document.documentElement.lang=state.locale;applyProductLabels(document,state.locale);
  document.documentElement.dir = productLocaleDirection(state.locale);
  document.documentElement.dataset.theme = state.theme;
  document.title = t("title");
  for (const element of document.querySelectorAll("[data-i18n]")) element.textContent = t(element.dataset.i18n);
  for (const element of document.querySelectorAll("[data-i18n-placeholder]")) element.placeholder = t(element.dataset.i18nPlaceholder);
  for (const element of document.querySelectorAll("[data-i18n-aria]")) element.setAttribute("aria-label", t(element.dataset.i18nAria));
  if (state.ready) render();
}

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.source !== parent) return;
  if (event.data?.type !== "teamaibox.plugin-preferences/v1" || event.data?.pluginId !== PLUGIN_ID) return;
  try {
    const applied = applyPluginPreferenceSnapshotV1({ currentDocument: document, snapshot: event.data });
    state.locale = normalizeProductLocale(applied.effective.locale);
    state.theme = applied.effective.theme;
    applyTranslations();
  } catch {
    failClosed(new CastingApiError("cast_preferences_invalid", "Invalid platform preferences", 502));
  }
});

async function plainJson(path) {
  return fetchCastingJsonV1(path, { headers: { accept: "application/json" } });
}

function show(element, message) {
  element.textContent = message || "";
  element.hidden = !message;
}

function notify(message) {
  clearTimeout(state.noticeTimer);
  show($("#global-notice"), message);
  state.noticeTimer = setTimeout(() => show($("#global-notice"), ""), 6_000);
}

function errorText(error) {
  const code = error?.code ?? "cast_request_failed";
  if (code === "cast_request_timeout") return t("requestTimeout");
  if (code === "cast_media_connection_unavailable") return productText(state.locale, "The viewing connection did not complete. Automatic retries have stopped; try joining again.", "观看连接未完成，已停止自动重试。请稍后重新加入。");
  if (code === "cast_media_client_unavailable") return t("errorMediaClient");
  if (code === "cast_output_change_requires_restart") return t("errorOutputRestart");
  if (code.startsWith("cast_office_") || code.startsWith("cast_memory_")) return t("errorOffice");
  if (new Set(["cast_output_invalid"]).has(code)) return t("errorOutput");
  if (new Set(["cast_audience_invalid", "cast_audience_denied"]).has(code)) return t("errorAudience");
  if (new Set(["cast_selected_users_required", "cast_audience_includes_initiator"]).has(code)) return t("errorUsers");
  if (code === "cast_selected_team_required") return t("errorTeam");
  if (code === "cast_view_required") return t("errorView");
  if (new Set(["cast_permission_required", "access_denied"]).has(code)) return t("errorShare");
  if (new Set(["cast_session_busy", "cast_source_busy", "cast_node_exclusive_busy"]).has(code)) return t("errorBusy");

  if (new Set(["cast_network_unavailable", "cast_media_connection_unavailable"]).has(code)) return t("errorNetwork");
  if (new Set(["invalid_session", "csrf_unavailable", "csrf_failed"]).has(code)) return t("errorSession");
  if (new Set(["cast_state_conflict", "cast_session_terminal", "cast_idempotency_conflict"]).has(code)) return t("errorConflict");
  if (code.startsWith("cast_invitation") || code === "cast_audience_revoked") return t("errorInvite");
  if (new Set(["not_found", "cast_response_invalid", "cast_capability_unavailable", "cast_preferences_invalid",
    "cast_media_client_unavailable", "cast_media_connection_invalid", "cast_media_connection_expired"]).has(code)) return t("errorUnavailable");
  return t("errorGeneric");
}

function showError(error, target = $("#global-error")) {
  const code = error?.code ?? "cast_request_failed";
  show(target, `${errorText(error)} · ${code}`);
}

function failClosed(error) {
  state.capabilityReady = false;
  state.loading = false;
  if (error?.code === "invalid_session") {
    state.actorIdentityId = null;
    state.permissions.clear();
    state.session = null;
    state.invitations = [];
    state.acceptedInvitations.clear();
    state.availability = null;
    viewingResume.clear();
  }
  $("#retry-bootstrap").hidden = false;
  discardMediaGrant();
  showError(error);
  render();
}

function initials(value) {
  const text = String(value ?? "?").trim();
  return [...text].slice(0, 2).join("").toLocaleUpperCase() || "?";
}

function formatTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(normalizeProductLocale(state.locale), { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function stateLabel(value) {
  return t(`state${String(value ?? "").charAt(0).toUpperCase()}${String(value ?? "").slice(1)}`);
}

function discardMediaGrant({ disconnect = true } = {}) {
  if (disconnect) void mediaClient.disconnect();
  mediaCredential = null;
  mediaSessionId = null;
  mediaAudienceRevision = null;
  mediaConnectionState = "disconnected";
  const video = $("#browser-video");
  if (video) {
    video.pause?.();
    if (video.srcObject) video.srcObject = null;
    video.removeAttribute("src");
    video.load?.();
  }
}

function reconcileSourcePlayback(session) {
  const result = sourceReconciliationV1({ previousSessionId: state.sourceStateSessionId,
    previousRevision: state.sourceStateRevision, session });
  if (result.action === "reject") {
    discardMediaGrant();
    throw new CastingApiError("cast_response_invalid", "Casting source state revision moved backwards", 502);
  }
  state.sourceStateSessionId = result.sessionId;
  state.sourceStateRevision = result.revision;
  if (mediaSessionId !== session?.id || !mediaClient.isConnected()) return;
  if (result.action === "suspend") mediaClient.suspendSource();
  if (result.action === "resume") mediaClient.resumeSource();
}

function adoptSessionConfiguration(session) {
  if (session?.perspective !== "initiator" || state.draftSessionId === session.id) return;
  state.draftSessionId = session.id;
  state.draftAudience = session.browserAudience ?? "owner_only";
  state.selectedUserIds = new Set(session.viewerUserIds ?? []);
  const radio = document.querySelector(`input[name="audience"][value="${state.draftAudience}"]`);
  if (radio) radio.checked = true;
  $("#team-id").value = session.viewerTeamId ?? "";
  $("#team-select").value = state.teams.some((team) => team.id === session.viewerTeamId) ? session.viewerTeamId : "";
  renderDirectory();
}

function clearSessionConfiguration() {
  if (state.draftSessionId === null) return;
  state.draftSessionId = null;
  state.draftAudience = "owner_only";
  state.selectedUserIds = new Set();
  document.querySelector('input[name="audience"][value="owner_only"]').checked = true;
  $("#team-id").value = "";
  $("#team-select").value = "";
  renderDirectory();
}

function renderDirectory() {
  const container = $("#directory-users");
  container.replaceChildren();
  const users = state.directory.filter((item) => item.id !== state.actorIdentityId);
  for (const person of users) {
    const label = document.createElement("label");
    label.className = "person-choice";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = person.id;
    input.checked = state.selectedUserIds.has(person.id);
    input.addEventListener("change", () => {
      if (input.checked) state.selectedUserIds.add(person.id); else state.selectedUserIds.delete(person.id);
      $("#selected-users-count").textContent = String(state.selectedUserIds.size);
    });
    const content = document.createElement("span");
    content.dataset.initials = initials(person.displayName);
    const names = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = person.displayName;
    const small = document.createElement("small");
    small.textContent = `@${person.username}`;
    names.append(strong, small); content.append(names); label.append(input, content); container.append(label);
  }
  $("#directory-empty").hidden = users.length > 0;
  $("#selected-users-count").textContent = String(state.selectedUserIds.size);
}

function renderTeams() {
  const select = $("#team-select");
  const current = select.value;
  select.replaceChildren();
  const option = document.createElement("option"); option.value = ""; option.textContent = t("chooseTeam"); select.append(option);
  for (const team of state.teams) {
    const item = document.createElement("option"); item.value = team.id; item.textContent = `${team.displayName} (${team.memberCount})`; select.append(item);
  }
  select.value = state.teams.some((team) => team.id === current) ? current : "";
  $("#manual-team-wrap").hidden = false;
}

function updateConditionalControls() {
  const browser = true;
  $("#browser-options").hidden = !browser;
  state.draftAudience = document.querySelector('input[name="audience"]:checked')?.value ?? "owner_only";
  $("#selected-users-control").hidden = !browser || state.draftAudience !== "selected_users";
  $("#selected-team-control").hidden = !browser || state.draftAudience !== "selected_team";
}

function renderConfiguration() {
  const session = state.session;
  const initiator = session?.perspective === "initiator";
  const allowed = state.capabilityReady && can("cast:use") && can("cast:view") && (!session || initiator);
  $("#configuration-card").hidden = !allowed;
  if (!allowed) return;
  const update = Boolean(initiator && ACTIVE_STATES.has(session.state));
  $("#configuration-mode").textContent = t(update ? "updateSession" : "newSession");
  $("#submit-session").querySelector("span:first-child").textContent = t(update ? "update" : "start");
  $("#ttl").disabled = update;
  const sharedDisabled = !can("cast:share");
  document.querySelector('input[name="audience"][value="selected_users"]').disabled = sharedDisabled || !state.directoryReady;
  document.querySelector('input[name="audience"][value="selected_team"]').disabled = sharedDisabled;
  updateConditionalControls();
}

function renderAvailability() {
  const availability = state.availability;
  const card = $("#availability-card");
  card.hidden = !availability || state.capabilityReady;
  if (card.hidden) return;
  $("#availability-state").textContent = t("availabilityUnsupported");
  $("#availability-summary").textContent = t("availabilitySummary");
  $("#availability-receiver").textContent = t("receiverNotReady");
  $("#availability-session").textContent = t("sessionStartBlocked");
  const outputs = $("#availability-outputs"); outputs.replaceChildren();
  for (const output of ["browser"]) {
    const item = document.createElement("div"); item.className = "availability-output";
    const name = document.createElement("strong"); name.textContent = t("outputBrowser");
    const reason = document.createElement("code"); reason.textContent = availability.outputs[output].reasonCode ?? availability.outputs[output].state;
    item.append(name, reason); outputs.append(item);
  }
  const gates = $("#availability-gates"); gates.replaceChildren();
  for (const gate of availability.gates) {
    const item = document.createElement("li");
    const heading = document.createElement("div");
    const category = document.createElement("span"); category.textContent = t(`gateCategory_${gate.category}`);
    const status = document.createElement("strong"); status.textContent = t("gateBlocked");
    heading.append(category, status);
    const description = document.createElement("p"); description.textContent = t(gate.code);
    const code = document.createElement("code"); code.textContent = gate.code;
    item.append(heading, description, code); gates.append(item);
  }
}

function healthText(value) {
  if (value === "waiting") return t("healthWaiting");
  return value === "available" ? t("healthAvailable") : value === "unavailable" ? t("healthUnavailable") : t("healthUnknown");
}

function renderOutputHealth(session) {
  const health = session.outputHealth ?? null;
  $("#receiver-health").textContent = health?.receiverHealthy === true ? t("receiverHealthy")
    : health?.receiverHealthy === false ? t("receiverUnhealthy") : t("receiverUnknown");
  const list = $("#output-health-list"); list.replaceChildren();
  for (const sink of session.outputSinks) {
    const value = outputHealthLabelV1(session, sink);
    const item = document.createElement("div"); item.className = "health-item";
    const name = document.createElement("strong"); name.textContent = t("outputBrowser");
    const status = document.createElement("span"); status.className = `health-state${value === "available" ? " is-good" : value === "unavailable" ? " is-bad" : ""}`; status.textContent = healthText(value);
    item.append(name, status); list.append(item);
  }
}

function acceptedInvitation(sessionId) {
  return state.acceptedInvitations.get(sessionId) ?? null;
}

function renderPlayer(session) {
  const allowed = session.perspective !== "manager" && session.outputSinks.includes("browser") && can("cast:view");
  $("#browser-player").hidden = !allowed;
  if (!allowed) return;
  // Credential expiry restricts new connections, not an established room.
  // Current session/permission checks and actual disconnects remain authoritative.
  const joined = mediaSessionId === session.id && mediaCredential !== null && mediaClient.isConnected();
  const invitation = acceptedInvitation(session.id);
  const joinEligible = session.perspective === "initiator" || Boolean(invitation);
  $("#join").hidden = joined || !joinEligible;
  $("#join").disabled = state.busy || !state.capabilityReady;
  $("#leave").hidden = !joined;
  $("#leave").disabled = state.busy;
  $("#unmute").hidden = !joined || !$("#browser-video").muted || !mediaClient.hasVideoTrack();
  $("#media-status").textContent = joined ? (mediaConnectionState === "playback-gesture-required" ? t("playbackGesture")
    : mediaConnectionState === "playback-failed" ? t("playbackFailed") : t("joined"))
    : new Set(["loading-client", "connecting"]).has(mediaConnectionState) ? t("connectingMedia") : t("notJoined");
  const sourceEnded = session.sourceState === "disconnected";
  const streaming = !sourceEnded && videoVisibleV1({ joined, hasVideoTrack: mediaClient.hasVideoTrack() });
  $("#browser-player").classList.toggle("source-ended", sourceEnded);
  const mediaMessage = new Set(["loading-client", "connecting"]).has(mediaConnectionState)
    ? t("connectingMedia") : mediaConnectionState === "reconnect-required"
      ? t("reconnectMedia") : t("waitingMedia");
  const disconnectMessage = state.viewerDisconnect?.sessionId === session.id ? t(state.viewerDisconnect.message) : null;
  $("#video-placeholder").querySelector("p").textContent = !joined && disconnectMessage ? disconnectMessage : !joinEligible && session.perspective === "viewer"
    ? t("inviteRequired") : sourceEnded ? t("sourceDisconnected") : joined ? mediaMessage : t("explicitJoin");
  $("#browser-video").hidden = !streaming;
  $("#video-placeholder").hidden = streaming && !sourceEnded;
}

function renderInvitees(session) {
  const card = $("#share-card");
  const eligible = session.perspective === "initiator" && session.outputSinks.includes("browser")
    && new Set(["selected_users", "selected_team"]).has(session.browserAudience) && can("cast:share");
  card.hidden = !eligible;
  if (!eligible) return;
  let ids = null;
  if (session.browserAudience === "selected_users") ids = new Set(session.viewerUserIds ?? []);
  if (session.browserAudience === "selected_team") {
    const team = state.teams.find((item) => item.id === session.viewerTeamId);
    if (team) ids = new Set(team.memberIdentityIds);
  }
  const people = state.directory.filter((person) => person.id !== state.actorIdentityId && (!ids || ids.has(person.id)));
  const select = $("#invitee"); select.replaceChildren();
  const empty = document.createElement("option"); empty.value = ""; empty.textContent = t("chooseUser"); select.append(empty);
  for (const person of people) { const option = document.createElement("option"); option.value = person.id; option.textContent = `${person.displayName} (@${person.username})`; select.append(option); }
  $("#invite").disabled = people.length === 0 || state.busy;
}

function renderViewers(session) {
  const owner = session?.perspective === "initiator" && ACTIVE_STATES.has(session.state);
  $("#viewers-card").hidden = !owner;
  $("#viewer-list").replaceChildren();
  $("#viewer-count").textContent = "0";
  if (!owner) return;
  $("#viewer-count").textContent = `${state.viewers.length}`;
  $("#viewer-empty").hidden = state.viewers.length > 0;
  const list = $("#viewer-list"); list.replaceChildren();
  for (const viewer of state.viewers) {
    const row = document.createElement("div"); row.className = "viewer-item";
    const identity = document.createElement("div"); identity.className = "viewer-identity";
    const avatar = document.createElement("span"); avatar.className = "avatar"; avatar.textContent = initials(viewer.displayName);
    const names = document.createElement("span"); const strong = document.createElement("strong");
    strong.textContent = viewer.displayName || viewer.viewerIdentityId;
    const small = document.createElement("small"); small.textContent = viewer.viewerIdentityId === state.actorIdentityId ? t("you") : t("joinedAt", { time: formatTime(viewer.joinedAt) });
    names.append(strong, small); identity.append(avatar, names); row.append(identity);
    if (viewer.viewerIdentityId !== state.actorIdentityId) {
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "remove-viewer"; remove.textContent = t("remove");
      remove.disabled = state.busy; remove.addEventListener("click", () => void removeViewer(viewer.viewerIdentityId)); row.append(remove);
    }
    list.append(row);
  }
}

function renderInvitations() {
  const visible = can("cast:view");
  $("#invitations-card").hidden = !visible;
  if (!visible) return;
  const accepted = [...state.acceptedInvitations.values()].filter(item => mediaSessionId !== item.sessionId || !mediaCredential);
  const current = [...state.invitations.filter((item) => item.state === "pending"),
    ...accepted.filter((item) => !state.invitations.some((pending) => pending.id === item.id))];
  $("#invitations-card").hidden = current.length === 0;
  $("#invitation-count").textContent = String(current.length);
  $("#invitation-empty").hidden = current.length > 0;
  const list = $("#invitation-list"); list.replaceChildren();
  for (const invitation of current) {
    const item = document.createElement("article"); item.className = "invitation-item";
    const head = document.createElement("div"); head.className = "invitation-item__head";
    const title = document.createElement("strong"); title.textContent = t("inviteWatchHint");
    const status = document.createElement("small"); status.textContent = t(`invitation${invitation.state.charAt(0).toUpperCase()}${invitation.state.slice(1)}`);
    head.append(title, status); item.append(head);
    if (invitation.state === "pending") {
      const actions = document.createElement("div"); actions.className = "invitation-actions";
      const accept = document.createElement("button"); accept.type = "button"; accept.className = "button button--primary"; accept.textContent = t("acceptWatch"); accept.disabled = state.busy;
      const decline = document.createElement("button"); decline.type = "button"; decline.className = "button button--secondary"; decline.textContent = t("decline"); decline.disabled = state.busy;
      accept.addEventListener("click", () => void acceptAndWatch(invitation.id));
      decline.addEventListener("click", () => void declineInvitation(invitation.id));
      actions.append(accept, decline); item.append(actions);
    } else if (invitation.state === "accepted") {
      const watch = document.createElement("button"); watch.type = "button"; watch.className = "button button--primary";
      watch.textContent = t("watchAccepted"); watch.disabled = state.busy;
      watch.addEventListener("click", () => void joinViewing()); item.append(watch);
    }
    list.append(item);
  }
}

function renderSession() {
  const presentation = presentationV1({ session: state.session, previouslyStreaming: state.streamedSessionId === state.session?.id });
  document.documentElement.dataset.castMode = presentation.mode;
  $("#session-card").hidden = !state.loading && !state.session;
  $("#diagnostics-card").hidden = !state.session;
  const layoutId = presentation.active ? state.session.id : null;
  if (state.layoutSessionId !== layoutId) {
    $("#cast-more").open = !presentation.active;
    state.layoutSessionId = layoutId;
  }
  $("#session-loading").hidden = !state.loading;
  const noSession = !state.loading && !state.session;
  $("#session-empty").hidden = !noSession;
  $("#session-detail").hidden = state.loading || !state.session;
  if (!state.session) {
    renderViewers(null);
    $("#share-card").hidden = true;
    $("#invitee").replaceChildren();
    $("#receiver-name").textContent = "—";
    $("#receiver-pin").textContent = "—";
    $("#source-label").textContent = "—";
    return;
  }
  const session = state.session;
  $("#session-state").textContent = presentation.disconnected ? t("stateDisconnected")
    : presentation.mode === "waiting" && session.state === "streaming" ? t("waitingMedia") : stateLabel(session.state);
  show($("#source-feedback"), presentation.disconnected ? t("sourceDisconnected") : "");
  $("#session-expiry").textContent = formatTime(session.expiresAt);
  $("#session-state-dot").className = `state-dot${presentation.mode === "streaming" ? " is-streaming" : ACTIVE_STATES.has(session.state) ? "" : " is-terminal"}`;
  const manager = session.perspective === "manager";
  const initiator = session.perspective === "initiator";
  $("#manager-viewer-count-wrap").hidden = !manager;
  $("#manager-viewer-count").textContent = `${Number.isSafeInteger(session.viewerCount) ? session.viewerCount : 0}`;
  const receiver = initiator ? session.receiver : null;
  $("#receiver-secrets").hidden = !receiver || (presentation.mode === "streaming" && !$("#cast-more").open);
  $("#receiver-name").textContent = receiver?.name ?? "—";
  $("#receiver-pin").textContent = receiver?.pin ?? "—";
  const sourceVisible = Boolean(receiver?.sourcePaired && receiver?.sourceDeviceLabel);
  $("#source-row").hidden = !sourceVisible;
  $("#source-label").textContent = sourceVisible ? receiver.sourceDeviceLabel : "—";
  $("#stop").hidden = !initiator;
  $("#stop").disabled = state.busy;
  $("#force-stop").hidden = !manager;
  $("#force-stop").disabled = state.busy;
  $("#manager-boundary").hidden = !manager;
  renderOutputHealth(session);
  renderPlayer(session);
  renderInvitees(session);
  renderViewers(session);
}

function render() {
  const chip = $("#service-chip");
  chip.className = `status-chip ${state.capabilityReady ? "status-chip--ready" : state.loading ? "status-chip--checking" : "status-chip--error"}`;
  chip.querySelector("span:last-child").textContent = t(state.capabilityReady ? "serviceReady" : state.loading ? "checking"
    : state.availability?.state === "unsupported" ? "serviceUnsupported" : "serviceUnavailable");
  $("#casting-workspace").hidden = !workspaceVisibleV1(state);
  renderAvailability(); renderConfiguration(); renderSession(); renderInvitations();
  if (state.capabilityReady && !can("cast:use") && can("cast:view") && state.ready) show($("#global-error"), t("permissionUse"));
  if (state.capabilityReady && !["cast:use", "cast:view", "cast:manage"].some((permission) => can(permission)) && state.ready) show($("#global-error"), t("permissionNone"));
}

async function loadPlatformContext() {
  const [bootstrap, catalog, availability] = await Promise.all([
    plainJson("/api/v1/session/bootstrap"), plainJson("/api/v1/applications"), api.availability(),
  ]);
  state.availability = availability;
  state.availabilityCheckedAt = Date.now();
  const actorIdentityId = bootstrap?.actor?.identityId ?? bootstrap?.actor?.identity_id;
  if (!UUID.test(actorIdentityId ?? "") || !Array.isArray(bootstrap?.permissions)) throw new CastingApiError("cast_response_invalid", "Session bootstrap is invalid", 502);
  const application = catalog?.applications?.find((item) => item?.pluginKey === PLUGIN_ID);
  if (!application || application.launchable !== true || application.authorized !== true
    || application.route?.pathPrefix !== `/plugins/${PLUGIN_ID}` || application.route?.integration !== "iframe") {
    throw new CastingApiError("cast_capability_unavailable", "Wireless casting application is not launchable", 503, true);
  }
  state.actorIdentityId = actorIdentityId.toLowerCase();
  state.permissions = new Set(bootstrap.permissions.filter((item) => typeof item === "string"));
  if (!["cast:use", "cast:view", "cast:manage"].some((permission) => can(permission))) {
    throw new CastingApiError("cast_permission_required", "No casting permission is available", 403);
  }
  state.capabilityReady = availability.state === "ready"
    && availability.receiverReady === true && availability.sessionStartAllowed === true;
}

async function loadDirectory() {
  if (!can("team:view")) return;
  try {
    const value = await plainJson("/api/v1/identities/directory?limit=50");
    if (value?.object !== "list" || !Array.isArray(value.data)) throw new Error();
    state.directory = value.data.flatMap((item) => UUID.test(item?.id ?? "") && typeof item?.username === "string" && typeof item?.displayName === "string"
      ? [{ id: item.id.toLowerCase(), username: item.username, displayName: item.displayName }] : []);
    state.directoryReady = state.directory.length === value.data.length;
  } catch {
    state.directory = []; state.directoryReady = false;
    if (can("cast:share")) show($("#global-error"), t("directoryUnavailable"));
  }
  renderDirectory();
}

async function loadTeams() {
  if (!can("cast:share") || !can("team:manage")) { renderTeams(); return; }
  try {
    const value = await plainJson("/api/v1/admin/teams?limit=200");
    if (!Array.isArray(value?.teams)) throw new Error();
    state.teams = value.teams.flatMap((item) => {
      if (!UUID.test(item?.id ?? "") || item.status !== "active" || typeof item.displayName !== "string" || !Array.isArray(item.members)) return [];
      return [{ id: item.id.toLowerCase(), displayName: item.displayName, memberCount: Number(item.memberCount) || item.members.length,
        memberIdentityIds: item.members.flatMap((member) => UUID.test(member?.identity?.id ?? "") ? [member.identity.id.toLowerCase()] : []) }];
    });
  } catch { state.teams = []; }
  renderTeams();
}

async function refresh() {
  if (!state.actorIdentityId || state.refreshing) return;
  const revision = state.mutationRevision;
  state.refreshing = true;
  try {
    if (Date.now() - state.availabilityCheckedAt > 10_000) {
      state.availabilityCheckedAt = Date.now();
      try {
        const availability = await api.availability();
        state.availability = availability;
        state.capabilityReady = availability.state === "ready" && availability.receiverReady === true && availability.sessionStartAllowed === true;
      } catch { /* Existing session controls remain usable during a readiness outage. */ }
    }
    const { session, viewers } = await readCastingSessionV1(api);
    const invitations = can("cast:view") ? await api.invitations() : [];
    if (revision !== state.mutationRevision) return;
    const changedSession = mediaSessionId && (mediaSessionId !== session?.id || mediaAudienceRevision !== session?.audienceRevision);
    if (changedSession) discardMediaGrant();
    if (session?.state === "streaming") state.streamedSessionId = session.id;
    else if (state.session?.id !== session?.id) state.streamedSessionId = null;
    reconcileSourcePlayback(session);
    state.session = session;
    state.invitations = invitations;
    for (const [sessionId, invitation] of state.acceptedInvitations) {
      if (sessionId !== session?.id || invitation.audienceRevision !== session?.audienceRevision
        || new Date(invitation.expiresAt) <= new Date()) state.acceptedInvitations.delete(sessionId);
    }
    // Recover consent metadata, never credentials. Polling does not join.
    const intent = viewingResume.read({ actorIdentityId: state.actorIdentityId, session, canView: can("cast:view") });
    if (intent?.invitationId) state.acceptedInvitations.set(session.id, Object.freeze({
      id: intent.invitationId, sessionId: session.id, audienceRevision: intent.audienceRevision,
      expiresAt: intent.expiresAt, state: "accepted",
    }));
    state.viewers = viewers;
    if (session?.perspective === "initiator") adoptSessionConfiguration(session); else if (!session) clearSessionConfiguration();
    state.loading = false;
    // Background polling must not erase an action error before the user can read it.
    render();
  } catch (error) {
    if (revision !== state.mutationRevision) return;
    state.loading = false;
    if (new Set(["invalid_session", "not_found", "cast_response_invalid", "cast_network_unavailable", "cast_request_timeout"]).has(error.code)) failClosed(error);
    else { showError(error); render(); }
  } finally { state.refreshing = false; }
}

function draft() {
  const audience = document.querySelector('input[name="audience"]:checked')?.value;
  const teamId = $("#team-select").value || $("#team-id").value;
  return {
    browser: true,
    browserAudience: audience,
    // Keep inactive choices in the form for switching back, not in the request.
    viewerUserIds: audience === "selected_users" ? [...state.selectedUserIds] : [],
    viewerTeamId: audience === "selected_team" ? teamId || null : null,
    ttlSeconds: Number($("#ttl").value),
  };
}

async function submitSession(event) {
  event.preventDefault();
  if (!state.capabilityReady) return;
  show($("#global-error"), "");
  show($("#form-error"), "");
  const validated = validateCastingDraftV1(draft(), state.actorIdentityId);
  if (!validated.valid) { showError({ code: validated.errors[0] }, $("#form-error")); return; }
  if (validated.body.output_sinks.includes("browser") && !can("cast:view")) { showError({ code: "cast_view_required" }, $("#form-error")); return; }
  if (new Set(["selected_users", "selected_team"]).has(validated.body.browser_audience) && !can("cast:share")) { showError({ code: "cast_permission_required" }, $("#form-error")); return; }
  state.busy = true; render();
  state.mutationRevision++;
  try {
    const update = state.session?.perspective === "initiator" && ACTIVE_STATES.has(state.session.state);
    discardMediaGrant();
    state.session = update ? await api.update(state.session.id, validated.body) : await api.start(validated.body);
    state.draftSessionId = null;
    adoptSessionConfiguration(state.session);
    notify(t(update ? "updated" : "started"));
    await refresh();
    if (joinAfterStartV1({ session: state.session, canView: can("cast:view") })) await joinViewing();
  } catch (error) { showError(error, $("#form-error")); }
  finally { state.busy = false; render(); }
}

async function stopSession(force = false) {
  const session = state.session;
  if (!session) return;
  viewingResume.clear();
  show($("#global-error"), "");
  state.busy = true; render();
  state.mutationRevision++;
  try {
    const stopped = force ? await api.forceStop(session.id) : await api.stop(session.id);
    state.session = stopped && ACTIVE_STATES.has(stopped.state) ? stopped : null;
    state.viewers = [];
    state.acceptedInvitations.delete(session.id);
    state.streamedSessionId = null;
    if (!state.session) clearSessionConfiguration();
    discardMediaGrant(); notify(t(force ? "forceStopped" : "stopped")); await refresh();
  } catch (error) { showError(error); }
  finally { state.busy = false; render(); }
}

// This explicit, labelled click combines consent and joining. Notification
// arrival, opening the page and polling never call this handler.
async function acceptAndWatch(invitationId) {
  const accepted = await acceptInvitationOnly(invitationId);
  if (accepted && state.session?.id === accepted.sessionId && state.session.perspective === "viewer") await joinViewing();
}

// Accept-only primitive has no media side effects.
async function acceptInvitationOnly(invitationId) {
  state.busy = true; render();
  try {
    const accepted = await api.accept(invitationId);
    if (accepted?.object !== "cast.viewer_invitation" || accepted?.state !== "accepted"
      || !UUID.test(accepted?.id ?? "") || !UUID.test(accepted?.sessionId ?? "")
      || !Number.isSafeInteger(accepted?.audienceRevision) || accepted.audienceRevision < 1
      || !Number.isFinite(new Date(accepted?.expiresAt).getTime())) {
      throw new CastingApiError("cast_response_invalid", "Accepted invitation response is invalid", 502);
    }
    state.acceptedInvitations.set(accepted.sessionId, Object.freeze({ ...accepted }));
    notify(t("invitationAcceptedNotice"));
    await refresh();
    return accepted;
  }
  catch (error) { showError(error); }
  finally { state.busy = false; render(); }
}

async function declineInvitation(invitationId) {
  state.busy = true; render();
  try { await api.decline(invitationId); notify(t("invitationDeclinedNotice")); await refresh(); }
  catch (error) { showError(error); }
  finally { state.busy = false; render(); }
}

async function sendInvitation() {
  const session = state.session; const identityId = $("#invitee").value;
  if (session?.perspective !== "initiator" || !UUID.test(identityId)) return;
  state.busy = true; render();
  try { await api.invite(session.id, identityId); notify(t("invitationSent")); }
  catch (error) { showError(error); }
  finally { state.busy = false; render(); }
}

async function joinViewing() {
  const session = state.session;
  if (!state.capabilityReady) return;
  show($("#global-error"), "");
  if (!session || session.perspective === "manager" || !session.outputSinks.includes("browser")) return;
  const invitation = session.perspective === "viewer" ? acceptedInvitation(session.id) : null;
  if (session.perspective === "viewer" && !invitation) { showError({ code: "cast_invitation_required" }); return; }
  state.viewerDisconnect = null;
  state.busy = true; render();
  try {
    const grant = await api.join(session.id, invitation?.id ?? null, browserInstanceId);
    const policy = browserPlaybackPolicyV1(session.outputSinks);
    const expiry = new Date(grant?.expiresAt);
    if (grant?.sessionId !== session.id || grant?.viewerIdentityId !== state.actorIdentityId
      || typeof grant?.mediaCredential !== "string" || grant.mediaCredential.length < 32
      || !Number.isFinite(expiry.getTime()) || expiry <= new Date() || grant?.muted !== policy.initiallyMuted) {
      await api.leave(session.id, browserInstanceId).catch(() => {});
      throw new CastingApiError("cast_response_invalid", "Viewer grant is invalid", 502);
    }
    mediaCredential = grant.mediaCredential;
    mediaSessionId = session.id;
    mediaAudienceRevision = session.audienceRevision;
    const connection = await api.mediaConnection(session.id, grant.mediaCredential, browserInstanceId);
    if (connection.sessionId !== grant.sessionId || connection.viewerIdentityId !== grant.viewerIdentityId
      || connection.grantId !== grant.grantId || connection.muted !== policy.initiallyMuted
      || new Date(connection.expiresAt) > expiry) {
      throw new CastingApiError("cast_media_connection_invalid", "Viewer media connection is invalid", 502);
    }
    await mediaClient.connect({ connection, videoElement: $("#browser-video"),
      onState(value) { mediaConnectionState = value; render(); },
      onDisconnected(reason) { void handleUnexpectedMediaDisconnect(session.id, reason); } });
    if (session.sourceState === "disconnected") mediaClient.suspendSource();
    viewingResume.save({ actorIdentityId: state.actorIdentityId, session, invitation, wantsViewing: true });
    notify(t("joinedNotice"));
  } catch (error) {
    viewingResume.clear();
    await mediaClient.disconnect();
    if (mediaSessionId) await api.leave(mediaSessionId, browserInstanceId).catch(() => {});
    discardMediaGrant({ disconnect: false });
    showError(error);
  }
  finally { state.busy = false; render(); }
}

async function handleUnexpectedMediaDisconnect(sessionId, reason = "connection_lost") {
  if (mediaSessionId !== sessionId) return;
  // Removal/end cancels automatic resume. Transport loss alone may resume
  // after a reload and fresh server authorization, never with stale grants.
  if (reason === "removed" || reason === "ended") {
    viewingResume.clear();
    state.acceptedInvitations.delete(sessionId);
  }
  state.viewerDisconnect = { sessionId,
    message: reason === "removed" ? "viewingRemoved" : reason === "ended" ? "viewingEnded" : "viewingDisconnected" };
  discardMediaGrant({ disconnect: false });
  notify(t(state.viewerDisconnect.message));
  render();
  await api.leave(sessionId, browserInstanceId).catch(() => {});
}

async function leaveViewing() {
  const sessionId = mediaSessionId ?? state.session?.id;
  if (!sessionId) return;
  rememberViewingPaused();
  state.busy = true; render();
  try {
    await mediaClient.disconnect();
    await api.leave(sessionId, browserInstanceId);
    discardMediaGrant({ disconnect: false }); notify(t("leftNotice")); await refresh();
  }
  catch (error) { discardMediaGrant(); showError(error); }
  finally { state.busy = false; render(); }
}

function rememberViewingPaused() {
  if (!state.session) { viewingResume.clear(); return; }
  viewingResume.save({ actorIdentityId: state.actorIdentityId, session: state.session,
    invitation: acceptedInvitation(state.session.id), wantsViewing: false });
}

async function resumeViewingOnce() {
  if (resumeAttempted) return;
  const intent = viewingResume.read({ actorIdentityId: state.actorIdentityId,
    session: state.session, canView: can("cast:view") });
  if (!intent?.wantsViewing || !state.capabilityReady) return;
  resumeAttempted = true;
  // Finish disposal of the previous document's viewer before issuing a fresh
  // grant. No credential, pairing PIN or media is restored from storage.
  try { await api.leave(intent.sessionId, browserInstanceId); }
  catch (error) { viewingResume.clear(); showError(error); return; }
  await joinViewing();
}

async function removeViewer(identityId) {
  const session = state.session;
  if (session?.perspective !== "initiator" || identityId === state.actorIdentityId) return;
  state.busy = true; render();
  try { await api.removeViewer(session.id, identityId); notify(t("viewerRemoved")); await refresh(); }
  catch (error) { showError(error); }
  finally { state.busy = false; render(); }
}

$("#casting-form").addEventListener("submit", submitSession);
for (const radio of document.querySelectorAll('input[name="audience"]')) radio.addEventListener("change", updateConditionalControls);
$("#team-select").addEventListener("change", () => { if ($("#team-select").value) $("#team-id").value = ""; });
$("#team-id").addEventListener("input", () => { if ($("#team-id").value) $("#team-select").value = ""; });
$("#refresh").addEventListener("click", () => void Promise.all([refresh(), loadDirectory(), loadTeams()]));
$("#cast-more").addEventListener("toggle", () => { if (state.ready) renderSession(); });
$("#open-more").addEventListener("click", () => { $("#cast-more").open = true; });
$("#unmute").addEventListener("click", async () => {
  const video = $("#browser-video"); video.muted = false;
  try { await video.play(); } catch { video.muted = true; }
  render();
});
$("#browser-video").addEventListener("volumechange", () => { if (state.ready) render(); });
$("#stop").addEventListener("click", () => void stopSession(false));
$("#force-stop").addEventListener("click", () => void stopSession(true));
$("#join").addEventListener("click", () => void joinViewing());
$("#leave").addEventListener("click", () => void leaveViewing());
$("#invite").addEventListener("click", () => void sendInvitation());

window.addEventListener("pagehide", () => {
  const sessionId = mediaSessionId;
  if (sessionId) void api.leave(sessionId, browserInstanceId).catch(() => {});
  discardMediaGrant();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refresh();
});

async function bootstrap() {
  if (state.bootstrapping || state.busy) return;
  state.bootstrapping = true;
  clearInterval(pollTimer);
  state.loading = true;
  $("#retry-bootstrap").hidden = true;
  show($("#global-error"), "");
  applyTranslations(); renderDirectory(); renderTeams();
  try {
    await loadPlatformContext();
    state.ready = true;
    render();
    if (state.actorIdentityId) {
      // Sharing directories are optional. A slow directory must not hide the
      // receiver controls or prevent stopping an existing authorized session.
      void Promise.all([loadDirectory(), loadTeams()]);
      await refresh();
      await resumeViewingOnce();
      pollTimer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 2_500);
    } else {
      state.loading = false;
      render();
    }
  } catch (error) {
    state.ready = true;
    failClosed(error);
  } finally { state.bootstrapping = false; }
  parent.postMessage({ type: "teamaibox.plugin-ready/v1", pluginId: PLUGIN_ID }, location.origin);
}

window.addEventListener("pagehide", () => clearInterval(pollTimer), { once: true });
$("#retry-bootstrap").addEventListener("click", () => void bootstrap());
void bootstrap();
