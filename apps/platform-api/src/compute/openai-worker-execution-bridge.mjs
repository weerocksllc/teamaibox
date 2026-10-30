import { createHash, randomUUID } from "node:crypto";

import { PlatformError } from "../../../../packages/observability/src/index.mjs";
import { NodeHttpsProviderTransport } from "../../../../services/scheduler/src/external-provider-contract-tester.mjs";

import {bufferedMediaBytes, bufferedMediaResponse, reserveBufferedMedia} from '../../../../services/object-service/src/buffered-media-budget.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const DRAWING_ORDINARY_ALIASES = new Set(["drawing.automatic", "drawing.fast"]);

function origin(value) {
  const parsed = new URL(value);
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password
      || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError("OpenAI worker origin is invalid");
  }
  return parsed.origin;
}

function model(value, label) {
  if (typeof value !== "string" || !/^[^\s\u0000-\u001f]{1,512}$/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function drawingConfiguration(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Drawing worker configuration is invalid");
  if (!UUID.test(value.profileId ?? "") || typeof value.profileKey !== "string" || !value.profileKey
      || !SHA256.test(value.profileFingerprint ?? "") || !SHA256.test(value.engineImageDigest ?? "")) {
    throw new TypeError("Drawing worker profile evidence is invalid");
  }
  const acceptedModelAliases = value.acceptedModelAliases ?? [value.modelAlias];
  if (!Array.isArray(acceptedModelAliases) || acceptedModelAliases.length < 1 || acceptedModelAliases.length > 16
      || new Set(acceptedModelAliases).size !== acceptedModelAliases.length) {
    throw new TypeError("Drawing accepted model aliases are invalid");
  }
  acceptedModelAliases.forEach((item) => model(item, "Drawing accepted model alias"));
  const ordinaryAliases = acceptedModelAliases.filter((item) => DRAWING_ORDINARY_ALIASES.has(item));
  if (ordinaryAliases.length > 0 && (
    ordinaryAliases.length !== DRAWING_ORDINARY_ALIASES.size
    || ![...DRAWING_ORDINARY_ALIASES].every((item) => acceptedModelAliases.includes(item))
    || !value.profileKey.startsWith("drawing.flux2-klein-4b.bf16.main-protected.")
  )) {
    throw new TypeError("Ordinary Drawing aliases require the configured protected main-box FLUX profile");
  }
  if (value.workerId !== undefined && !UUID.test(value.workerId ?? "")) {
    throw new TypeError("Drawing worker identity is invalid");
  }
  if (value.bearerToken !== undefined && (!(value.bearerToken instanceof Uint8Array)
      || value.bearerToken.byteLength < 8 || value.bearerToken.byteLength > 8_192)) {
    throw new TypeError("Drawing worker credential is invalid");
  }
  return Object.freeze({
    origin: origin(value.workerOrigin),
    modelAlias: model(value.modelAlias, "Drawing model alias"),
    acceptedModelAliases: Object.freeze([...acceptedModelAliases]),
    servedModel: model(value.servedModel, "Drawing served model"),
    workerId: value.workerId?.toLowerCase() ?? null,
    profileId: value.profileId,
    profileKey: value.profileKey,
    profileFingerprint: value.profileFingerprint,
    engineImageDigest: value.engineImageDigest,
    bearerToken: value.bearerToken ? Buffer.from(value.bearerToken) : null,
    route: ordinaryAliases.length > 0 ? "local" : "managed_node",
  });
}

function drawingJobMatchesConfiguration(job, request, configured) {
  if (!configured || !configured.acceptedModelAliases.includes(job?.model)
      || !new Set(["images.generations", "images.edits"]).has(job?.operation)
      || typeof request?.prompt !== "string") return false;
  if (!DRAWING_ORDINARY_ALIASES.has(job.model)) {
    return job.profileId === null || job.profileId === undefined
      || job.profileId.toLowerCase() === configured.profileId.toLowerCase();
  }
  const authorization = request?.x_teamaibox?.routing_authorization;
  return job.operation === "images.generations"
    && job.profileId?.toLowerCase() === configured.profileId.toLowerCase()
    && authorization?.schema === "teamaibox.drawing-route-authorization.v2"
    && authorization?.policy_version === "protected-main-default.v1"
    && authorization?.selection_class === "ordinary-protected"
    && authorization?.model_alias === job.model
    && authorization?.operation === job.operation
    && authorization?.model_profile_id?.toLowerCase() === configured.profileId.toLowerCase();
}

function profiledWorkerConfiguration(value, kind) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${kind} worker configuration is invalid`);
  if (!UUID.test(value.profileId ?? "") || typeof value.profileKey !== "string" || !value.profileKey
      || !SHA256.test(value.profileFingerprint ?? "") || !SHA256.test(value.engineImageDigest ?? "")) {
    throw new TypeError(`${kind} worker profile evidence is invalid`);
  }
  if (value.workerId !== undefined && !UUID.test(value.workerId ?? "")) {
    throw new TypeError(`${kind} worker identity is invalid`);
  }
  const workerOrigin = origin(value.workerOrigin);
  const protocol = kind === "OCR" ? (value.protocol ?? "layout-parsing-v1") : null;
  if (kind === "OCR" && !new Set(["layout-parsing-v1", "hunyuan-managed-v1"]).has(protocol)) {
    throw new TypeError("OCR worker protocol is invalid");
  }
  const transportSecurity = value.transportSecurity ?? null;
  if (transportSecurity !== null && (!transportSecurity || typeof transportSecurity !== "object" || Array.isArray(transportSecurity)
      || !(transportSecurity.credential instanceof Uint8Array) || transportSecurity.credential.byteLength < 8 || transportSecurity.credential.byteLength > 8_192
      || !(transportSecurity.customCa instanceof Uint8Array) || transportSecurity.customCa.byteLength < 1 || transportSecurity.customCa.byteLength > 1024 * 1024
      || (transportSecurity.serverName !== null && transportSecurity.serverName !== undefined
        && (typeof transportSecurity.serverName !== "string" || !/^[A-Za-z0-9.-]{1,253}$/.test(transportSecurity.serverName))))) {
    throw new TypeError(`${kind} worker transport security is invalid`);
  }
  if (transportSecurity && !workerOrigin.startsWith("https://")) throw new TypeError(`${kind} secure worker must use HTTPS`);
  return Object.freeze({
    origin: workerOrigin,
    modelAlias: model(value.modelAlias, `${kind} model alias`),
    servedModel: model(value.servedModel, `${kind} served model`),
    workerId: value.workerId?.toLowerCase() ?? null,
    profileId: value.profileId,
    profileKey: value.profileKey,
    profileFingerprint: value.profileFingerprint,
    engineImageDigest: value.engineImageDigest,
    ...(kind === "OCR" ? { protocol } : {}),
    route: new Set(["Embedding", "Translation"]).has(kind) ? "local" : "managed_node",
    secure: transportSecurity ? Object.freeze({
      transport: new NodeHttpsProviderTransport(),
      credential: Buffer.from(transportSecurity.credential),
      customCa: Buffer.from(transportSecurity.customCa),
      provider: Object.freeze({
        endpoint: workerOrigin,
        auth: Object.freeze({ scheme: "bearer", headerName: null }),
        trust: Object.freeze({ mode: "custom_ca", serverName: transportSecurity.serverName ?? null }),
      }),
    }) : null,
  });
}

function imageFormat(value) {
  return {
    png: { mediaType: "image/png", extension: "png" },
    jpeg: { mediaType: "image/jpeg", extension: "jpg" },
    webp: { mediaType: "image/webp", extension: "webp" },
  }[value] ?? null;
}

function imageBytes(value) {
  if (typeof value !== "string" || value.length < 4 || value.length > Math.ceil(bufferedMediaBytes() * 4 / 3) + 8
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new PlatformError("compute_worker_invalid", "The drawing worker returned invalid image data", { status: 502 });
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength < 1 || bytes.byteLength > bufferedMediaBytes() || bytes.toString("base64") !== value) {
    bytes.fill(0);
    throw new PlatformError("compute_worker_invalid", "The drawing worker returned invalid image data", { status: 502 });
  }
  return bytes;
}

async function boundedJson(response) {
  const bytes=await bufferedMediaResponse(response);
  try {return JSON.parse(bytes.toString('utf8'));}
  catch {throw new PlatformError('compute_worker_invalid','The model worker returned invalid JSON',{status:502});}
  finally {bytes.fill(0);}
}

function asrMultipart({ content, mediaType, extension, modelName, language, timestampGranularities }) {
  const boundary = `teamaibox-${randomUUID()}`;
  const parts = [];
  const append = (name, value) => {
    if (!/^[a-z][a-z0-9_[\]]{0,63}$/.test(name) || typeof value !== "string" || /[\r\n\0]/.test(value)) {
      throw new PlatformError("invalid_compute_request", "ASR multipart metadata is invalid", { status: 400 });
    }
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  };
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="source.${extension}"\r\nContent-Type: ${mediaType}\r\n\r\n`));
  parts.push(content, Buffer.from("\r\n"));
  append("model", modelName);
  append("response_format", "verbose_json");
  append("temperature", "0");
  for (const item of timestampGranularities) append("timestamp_granularities[]", item);
  if (language) append("language", language.split("-")[0].toLowerCase());
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function ocrBoundingBox(value) {
  const flattened = Array.isArray(value) ? value.flat(2) : [];
  if (flattened.length < 4 || flattened.length > 8 || flattened.some((item) => !Number.isFinite(item))) {
    throw new PlatformError("compute_worker_invalid", "The OCR worker returned an invalid bounding box", { status: 502 });
  }
  return flattened;
}

function ocrPages(body) {
  const rawPages = body?.result?.layoutParsingResults;
  if (!Array.isArray(rawPages) || rawPages.length < 1) {
    throw new PlatformError("compute_worker_invalid", "The OCR worker returned invalid page results", { status: 502 });
  }
  return rawPages.map((page, pageIndex) => {
    const pruned = page?.prunedResult;
    const rawBlocks = pruned?.parsing_res_list;
    const geometrySupported = pruned?.geometry_supported !== false;
    const width = pruned?.width === null || pruned?.width === undefined ? null : Number(pruned.width);
    const height = pruned?.height === null || pruned?.height === undefined ? null : Number(pruned.height);
    if (!pruned || typeof pruned !== "object" || !Array.isArray(rawBlocks)
        || (geometrySupported && (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0))
        || (!geometrySupported && (width !== null || height !== null))) {
      throw new PlatformError("compute_worker_invalid", "The OCR worker returned invalid layout results", { status: 502 });
    }
    return Object.freeze({
      page_number: pageIndex + 1,
      width,
      height,
      geometry_supported: geometrySupported,
      blocks: Object.freeze(rawBlocks.map((block, blockIndex) => {
        if (!block || typeof block !== "object" || typeof block.block_content !== "string") {
          throw new PlatformError("compute_worker_invalid", "The OCR worker returned an invalid layout block", { status: 502 });
        }
        const rawConfidence = block.confidence ?? block.block_score;
        const confidence = rawConfidence === null || rawConfidence === undefined ? null : Number(rawConfidence);
        const blockType = typeof block.block_label === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(block.block_label)
          ? block.block_label : "text";
        const contentFormat = typeof block.block_format === "string" && /^(none|text|markdown|html|latex)$/.test(block.block_format)
          ? block.block_format : "text";
        const structure = block.block_structure;
        if (structure !== undefined && (
          blockType !== "table" || structure?.format !== "otsl-v1.0"
          || !Number.isSafeInteger(structure.rows) || structure.rows < 1
          || !Number.isSafeInteger(structure.columns) || structure.columns < 1
          || !Array.isArray(structure.cells)
          || typeof structure.html !== "string"
        )) {
          throw new PlatformError("compute_worker_invalid", "The OCR worker returned an invalid table structure", { status: 502 });
        }
        const rawReadingOrder = block.reading_order ?? blockIndex;
        const readingOrder = Number(rawReadingOrder);
        const blockGeometrySupported = block.geometry_supported ?? geometrySupported;
        if (typeof blockGeometrySupported !== "boolean" || blockGeometrySupported !== geometrySupported
            || (!geometrySupported && block.block_bbox !== null && block.block_bbox !== undefined)) {
          throw new PlatformError("compute_worker_invalid", "The OCR worker returned inconsistent geometry metadata", { status: 502 });
        }
        return Object.freeze({
          id: `p${pageIndex + 1}-b${String(block.block_id ?? blockIndex + 1).slice(0, 96)}`,
          text: block.block_content,
          bounding_box: geometrySupported ? Object.freeze(ocrBoundingBox(block.block_bbox)) : null,
          geometry_supported: geometrySupported,
          confidence: confidence !== null && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : null,
          language: typeof block.language === "string" && block.language.length <= 64 ? block.language : null,
          block_type: blockType,
          content_format: contentFormat,
          ...(structure === undefined ? {} : { structure: Object.freeze(structuredClone(structure)) }),
          reading_order: Number.isFinite(readingOrder) && readingOrder >= 0 ? readingOrder : blockIndex,
        });
      })),
    });
  });
}

function providerRouteKind(route) {
  return route?.routeKind === "managed_node" || route?.provider?.providerKind === "managed_node"
    ? "managed_node" : "external_provider";
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function ocrArtifactBytes({ format, text, pages }) {
  if (format === "json") return { extension: "json", mediaType: "application/json", bytes: Buffer.from(JSON.stringify({ text, pages }), "utf8") };
  if (format === "markdown") return { extension: "md", mediaType: "text/markdown; charset=utf-8", bytes: Buffer.from(text, "utf8") };
  if (format === "hocr") {
    const html = `<!doctype html><html><body>${pages.map((page) => `<div class="ocr_page" id="page_${page.page_number}">${page.blocks.map((block) => `<span class="ocrx_word" id="${escapeHtml(block.id)}"${block.bounding_box ? ` title="bbox ${block.bounding_box.join(" ")}"` : ""}>${escapeHtml(block.text)}</span>`).join("\n")}</div>`).join("\n")}</body></html>`;
    return { extension: "html", mediaType: "text/html; charset=utf-8", bytes: Buffer.from(html, "utf8") };
  }
  return { extension: "txt", mediaType: "text/plain; charset=utf-8", bytes: Buffer.from(text, "utf8") };
}

function asrMedia(value) {
  return {
    "audio/wav": { extension: "wav" },
    "audio/x-wav": { extension: "wav" },
    "audio/flac": { extension: "flac" },
    "audio/x-flac": { extension: "flac" },
    "audio/ogg": { extension: "ogg" },
    "audio/webm": { extension: "webm" },
    "audio/mpeg": { extension: "mp3" },
    "audio/mp4": { extension: "m4a" },
    "audio/aiff": { extension: "aiff" },
    "audio/x-aiff": { extension: "aiff" },
    "video/mp4": { extension: "mp4" },
    "video/webm": { extension: "webm" },
  }[value] ?? null;
}

function asrTimestamp(value, separator) {
  const milliseconds = Math.max(0, Math.round(value * 1_000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000);
  const seconds = Math.floor(milliseconds % 60_000 / 1_000);
  const remainder = milliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${separator}${String(remainder).padStart(3, "0")}`;
}

function asrSegments(body) {
  if (!Array.isArray(body?.segments)) {
    throw new PlatformError("compute_worker_invalid", "The ASR worker returned invalid transcript segments", { status: 502 });
  }
  let previousStart = 0;
  return body.segments.map((segment, index) => {
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    if (!segment || typeof segment !== "object" || typeof segment.text !== "string"
        || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start
        || start < previousStart) {
      throw new PlatformError("compute_worker_invalid", "The ASR worker returned an invalid transcript timeline", { status: 502 });
    }
    previousStart = start;
    const rawWords = segment.words;
    if (rawWords !== undefined && !Array.isArray(rawWords)) {
      throw new PlatformError("compute_worker_invalid", "The ASR worker returned invalid word timestamps", { status: 502 });
    }
    const words = (rawWords ?? []).map((word) => {
      const wordStart = Number(word?.start);
      const wordEnd = Number(word?.end);
      if (!word || typeof word.word !== "string" || !Number.isFinite(wordStart) || !Number.isFinite(wordEnd)
          || wordStart < start || wordEnd < wordStart || wordEnd > end + 0.001) {
        throw new PlatformError("compute_worker_invalid", "The ASR worker returned an invalid word timeline", { status: 502 });
      }
      const probability = word.probability === null || word.probability === undefined ? null : Number(word.probability);
      return Object.freeze({
        text: word.word,
        start_seconds: wordStart,
        end_seconds: wordEnd,
        confidence: probability !== null && Number.isFinite(probability) && probability >= 0 && probability <= 1 ? probability : null,
      });
    });
    return Object.freeze({
      id: `segment-${String(segment.id ?? index + 1).slice(0, 96)}`,
      start_seconds: start,
      end_seconds: end,
      text: segment.text,
      speaker: null,
      words: Object.freeze(words),
    });
  });
}

function asrArtifactBytes({ format, result }) {
  if (format === "json") {
    return { extension: "json", mediaType: "application/json", bytes: Buffer.from(JSON.stringify(result), "utf8") };
  }
  if (format === "text") {
    return { extension: "txt", mediaType: "text/plain; charset=utf-8", bytes: Buffer.from(result.text, "utf8") };
  }
  const separator = format === "vtt" ? "." : ",";
  const lines = format === "vtt" ? ["WEBVTT", ""] : [];
  result.segments.forEach((segment, index) => {
    if (format === "srt") lines.push(String(index + 1));
    lines.push(`${asrTimestamp(segment.start_seconds, separator)} --> ${asrTimestamp(segment.end_seconds, separator)}`);
    lines.push(segment.text.trim(), "");
  });
  return {
    extension: format,
    mediaType: format === "vtt" ? "text/vtt; charset=utf-8" : "application/x-subrip; charset=utf-8",
    bytes: Buffer.from(lines.join("\n"), "utf8"),
  };
}

function translationArtifactBytes({ format, result }) {
  if (format === "json") {
    return { extension: "json", mediaType: "application/json", bytes: Buffer.from(JSON.stringify(result), "utf8") };
  }
  if (format === "markdown") {
    return { extension: "md", mediaType: "text/markdown; charset=utf-8", bytes: Buffer.from(result.text, "utf8") };
  }
  if (format === "srt" || format === "vtt") {
    const separator = format === "vtt" ? "." : ",";
    const lines = format === "vtt" ? ["WEBVTT", ""] : [];
    result.segments.forEach((segment, index) => {
      if (format === "srt") lines.push(String(index + 1));
      lines.push(`${asrTimestamp(segment.start_ms / 1_000, separator)} --> ${asrTimestamp(segment.end_ms / 1_000, separator)}`);
      lines.push(segment.translated_text.trim(), "");
    });
    return {
      extension: format,
      mediaType: format === "vtt" ? "text/vtt; charset=utf-8" : "application/x-subrip; charset=utf-8",
      bytes: Buffer.from(lines.join("\n"), "utf8"),
    };
  }
  return { extension: "txt", mediaType: "text/plain; charset=utf-8", bytes: Buffer.from(result.text, "utf8") };
}

function translationCompletion(body, expectedSegments, requestedSourceLanguage) {
  const content = body?.choices?.[0]?.message?.content;
  if (body?.object !== "chat.completion" || typeof content !== "string" || Buffer.byteLength(content, "utf8") > bufferedMediaBytes()) {
    throw new PlatformError("compute_worker_invalid", "The translation worker returned an invalid completion", { status: 502 });
  }
  let value;
  try {
    value = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    throw new PlatformError("compute_worker_invalid", "The translation worker returned invalid JSON", { status: 502 });
  }
  const translations = Array.isArray(value?.translations) ? value.translations
    : Array.isArray(value?.segments) ? value.segments : null;
  if (!translations || translations.length !== expectedSegments
      || translations.some((item) => typeof item !== "string" || Buffer.byteLength(item, "utf8") > 4 * 1024 * 1024)) {
    throw new PlatformError("compute_worker_invalid", "The translation worker returned an invalid aligned result", { status: 502 });
  }
  const detected = typeof value.source_language === "string" && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value.source_language)
    ? value.source_language : requestedSourceLanguage;
  const usage = body.usage ?? null;
  if (usage !== null && (!Number.isSafeInteger(usage.prompt_tokens) || usage.prompt_tokens < 0
      || !Number.isSafeInteger(usage.completion_tokens) || usage.completion_tokens < 0
      || !Number.isSafeInteger(usage.total_tokens) || usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens)) {
    throw new PlatformError("compute_worker_invalid", "The translation worker returned invalid usage", { status: 502 });
  }
  return { translations, sourceLanguage: detected ?? null,
    usage: usage === null ? null : { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens } };
}

function abortSignal(controller, milliseconds) {
  return AbortSignal.any([controller.signal, AbortSignal.timeout(milliseconds)]);
}

async function* streamChunks(body) {
  if (typeof body?.getReader === "function") {
    const reader = body.getReader();
    try {
      while (true) {
        const item = await reader.read();
        yield item;
        if (item.done) break;
      }
    } finally {
      reader.releaseLock?.();
    }
    return;
  }
  if (body?.[Symbol.asyncIterator]) {
    for await (const chunk of body) yield { value: chunk, done: false };
    yield { value: new Uint8Array(), done: true };
    return;
  }
  throw new PlatformError("compute_worker_invalid", "The model worker returned an unreadable stream", { status: 502 });
}

async function cancelStream(body) {
  if (typeof body?.cancel === "function") await body.cancel().catch(() => {});
  else body?.destroy?.();
}

function records(buffer) {
  const values = [];
  let boundary;
  while ((boundary = buffer.indexOf("\n\n")) >= 0) {
    const block = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    const data = block.split("\n").filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (data) values.push(data);
  }
  return { values, remainder: buffer };
}

function workerFailure(status) {
  if (status === 429) return new PlatformError("compute_worker_busy", "The selected model worker is busy", { status: 503, retryable: true });
  if (status >= 500) return new PlatformError("compute_worker_unavailable", "The selected model worker is unavailable", { status: 503, retryable: true });
  return new PlatformError("compute_worker_rejected", "The selected model worker rejected the request", { status: 502 });
}

function workerRequest(request, servedModel, stream) {
  const value = structuredClone(request);
  delete value.x_teamaibox;
  // A queued streaming request may be executed by the background dispatcher.
  // Select options for the actual worker transport, not the original caller.
  delete value.stream_options;
  return {
    ...value,
    model: servedModel,
    stream,
    chat_template_kwargs: { enable_thinking: false },
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };
}

function drawingRequest(request, servedModel, jobId) {
  const drawing = request.x_teamaibox?.extensions?.drawing ?? {};
  return {
    model: servedModel,
    prompt: request.prompt,
    n: request.n ?? 1,
    size: request.size ?? "1024x1024",
    response_format: "b64_json",
    x_teamaibox: {
      job_id: jobId,
      seed: drawing.seed,
      steps: drawing.steps,
      guidance_scale: drawing.guidance_scale,
      negative_prompt: drawing.negative_prompt ?? "",
      output_format: drawing.output_format ?? "png",
      preset_key: drawing.preset_key ?? "drawing.balanced.v1",
    },
  };
}

async function drawingEditRequest({ request, servedModel, jobId, ownerIdentityId, objects }) {
  const sourceReferenceId = request.input?.referenceId;
  const maskReferenceId = request.mask?.referenceId ?? null;
  if (!UUID.test(sourceReferenceId ?? "") || (maskReferenceId !== null && !UUID.test(maskReferenceId))) {
    throw new PlatformError("compute_artifact_input_invalid", "Drawing edit input reference is invalid", { status: 400 });
  }
  const source = await objects.download({
    actorIdentityId: ownerIdentityId, referenceId: sourceReferenceId,
    audience: "compute:image",
  });
  const mask = maskReferenceId ? await objects.download({
    actorIdentityId: ownerIdentityId, referenceId: maskReferenceId,
    audience: "compute:image",
  }) : null;
  if (!Buffer.isBuffer(source?.content) || source.content.byteLength < 1
      || (mask && (!Buffer.isBuffer(mask.content) || mask.content.byteLength < 1))) {
    throw new PlatformError("compute_artifact_input_invalid", "Drawing edit input bytes are invalid", { status: 400 });
  }
  try {
    return {
      body: {
        model: servedModel,
        prompt: request.prompt,
        n: request.count ?? 1,
        size: request.size ?? "1024x1024",
        response_format: "b64_json",
        image_b64: source.content.toString("base64"),
        ...(mask ? { mask_b64: mask.content.toString("base64") } : {}),
        x_teamaibox: {
          job_id: jobId,
          seed: request.seed,
          steps: request.steps,
          guidance_scale: request.guidanceScale,
          negative_prompt: request.negativePrompt ?? "",
          output_format: request.outputFormat ?? "png",
          preset_key: request.presetKey ?? "drawing.balanced.v1",
          strength: request.strength ?? 0.65,
        },
      },
      sourceReferenceId,
      maskReferenceId,
    };
  } finally {
    source.content.fill(0);
    mask?.content.fill(0);
  }
}

function finalChat({ chunks, requestedModel }) {
  const first = chunks.find((item) => typeof item?.id === "string");
  const choices = chunks.flatMap((item) => item?.choices ?? []).filter((choice) => choice?.index === 0);
  const deltas = choices.map((choice) => choice?.delta?.content).filter((value) => typeof value === "string");
  const tools = new Map();
  for (const delta of choices.map((choice) => choice?.delta?.tool_calls).filter(Array.isArray).flat()) {
    if (!delta || !Number.isSafeInteger(delta.index) || delta.index < 0 || delta.index > 127) {
      throw new PlatformError("compute_worker_tool_index_invalid", "The model stream contained an invalid tool call", { status: 502 });
    }
    const current = tools.get(delta.index) ?? { index: delta.index, id: null, type: "function", name: "", arguments: "" };
    if (delta.id !== undefined && delta.id !== null && (typeof delta.id !== "string" || !delta.id
        || (current.id !== null && current.id !== delta.id))) {
      throw new PlatformError("compute_worker_tool_id_invalid", "The model stream contained an invalid tool call identifier", { status: 502 });
    }
    if (delta.type !== undefined && delta.type !== null && delta.type !== "function") {
      throw new PlatformError("compute_worker_tool_type_invalid", "The model stream contained an unsupported tool call", { status: 502 });
    }
    if (delta.function !== undefined && (!delta.function || typeof delta.function !== "object" || Array.isArray(delta.function)
        || (delta.function.name !== undefined && delta.function.name !== null && typeof delta.function.name !== "string")
        || (delta.function.arguments !== undefined && delta.function.arguments !== null && typeof delta.function.arguments !== "string"))) {
      throw new PlatformError("compute_worker_tool_arguments_invalid", "The model stream contained invalid tool arguments", { status: 502 });
    }
    if (delta.id !== undefined && delta.id !== null) current.id = delta.id;
    current.name += delta.function?.name ?? "";
    current.arguments += delta.function?.arguments ?? "";
    tools.set(delta.index, current);
  }
  const toolCalls = [...tools.values()].sort((left, right) => left.index - right.index).map((tool) => {
    if (typeof tool.id !== "string" || !tool.id || !tool.name) {
      throw new PlatformError("compute_worker_tool_incomplete", "The model stream ended with an incomplete tool call", { status: 502 });
    }
    return { id: tool.id, type: "function", function: { name: tool.name, arguments: tool.arguments } };
  });
  const finishReason = chunks.flatMap((item) => item?.choices ?? [])
    .findLast((choice) => choice?.index === 0 && typeof choice.finish_reason === "string")?.finish_reason ?? "stop";
  const usage = chunks.findLast((item) => item?.usage)?.usage ?? null;
  const content = deltas.join("");
  return {
    id: first?.id ?? `chatcmpl_${randomUUID().replaceAll("-", "")}`,
    object: "chat.completion",
    created: Number.isSafeInteger(first?.created) ? first.created : Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: content || (toolCalls.length ? null : ""),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason,
    }],
    ...(usage ? { usage } : {}),
  };
}

export class OpenAiWorkerExecutionBridge {
  #jobs;
  #origin;
  #modelAlias;
  #servedModel;
  #fetch;
  #timeout;
  #drawing;
  #ocr;
  #asr;
  #translation;
  #embedding;
  #externalRouter;
  #externalAttempts;
  #localAttempts;
  #localWorker;
  #objects;
  #active = new Map();

  constructor({
    jobService, workerOrigin, modelAlias, servedModel, drawingWorker = null, ocrWorker = null, asrWorker = null,
    translationWorker = null, embeddingWorker = null, objectGateway = null, externalProviderRouter = null,
    externalAttemptRepository = null, localAttemptRepository = null, workerId = null, profileId = null,
    fetchImplementation = globalThis.fetch, requestTimeoutMilliseconds = 1_800_000,
  }) {
    if (!jobService?.executionInput || !jobService?.markPreparing || !jobService?.markRunning
        || !jobService?.complete || !jobService?.fail) throw new TypeError("Durable job execution service is incomplete");
    if (typeof fetchImplementation !== "function") throw new TypeError("OpenAI worker fetch implementation is required");
    if (externalProviderRouter !== null && (!externalProviderRouter?.resolve || !externalProviderRouter?.request
        || !externalProviderRouter?.stream || !externalProviderRouter?.probe)) {
      throw new TypeError("External provider execution router is incomplete");
    }
    if (externalAttemptRepository !== null && (!externalAttemptRepository?.begin
        || !externalAttemptRepository?.markAccepted || !externalAttemptRepository?.observeOutput)) {
      throw new TypeError("External provider attempt repository is incomplete");
    }
    if (localAttemptRepository !== null && !localAttemptRepository?.begin) {
      throw new TypeError("Protected local attempt repository is incomplete");
    }
    if ((workerId !== null || profileId !== null) && (!UUID.test(workerId ?? "") || !UUID.test(profileId ?? ""))) {
      throw new TypeError("Local OpenAI worker identity is invalid");
    }
    if (!Number.isSafeInteger(requestTimeoutMilliseconds) || requestTimeoutMilliseconds < 1_000 || requestTimeoutMilliseconds > 3_600_000) {
      throw new TypeError("OpenAI worker timeout is invalid");
    }
    this.#jobs = jobService;
    this.#origin = origin(workerOrigin);
    this.#modelAlias = model(modelAlias, "OpenAI model alias");
    this.#servedModel = model(servedModel, "OpenAI served model");
    this.#fetch = fetchImplementation;
    this.#timeout = requestTimeoutMilliseconds;
    this.#drawing = drawingConfiguration(drawingWorker);
    this.#ocr = profiledWorkerConfiguration(ocrWorker, "OCR");
    this.#asr = profiledWorkerConfiguration(asrWorker, "ASR");
    this.#translation = profiledWorkerConfiguration(translationWorker, "Translation");
    this.#embedding = profiledWorkerConfiguration(embeddingWorker, "Embedding");
    this.#externalRouter = externalProviderRouter;
    this.#externalAttempts = externalAttemptRepository;
    this.#localAttempts = localAttemptRepository;
    this.#localWorker = workerId === null ? null : Object.freeze({
      workerId: workerId.toLowerCase(), profileId: profileId.toLowerCase(), route: "local",
    });
    if (this.#localAttempts && (!this.#localWorker
        || [this.#drawing, this.#ocr, this.#asr, this.#translation, this.#embedding]
          .filter(Boolean).some((configured) => !configured.workerId))) {
      throw new TypeError("Protected local attempts require exact worker and profile identities for every local route");
    }
    if ((this.#drawing || this.#ocr || this.#asr || this.#translation)
        && (!objectGateway?.storeOutput || !objectGateway?.issue || !objectGateway?.download)) {
      throw new TypeError("Artifact compute execution requires protected object storage");
    }
    this.#objects = objectGateway;
  }

  async #prepare(jobId, ownerIdentityId) {
    if (this.#active.has(jobId)) throw new PlatformError("job_execution_in_progress", "Compute job execution is already active", { status: 409, retryable: true });
    const controller = new AbortController();
    const active = { controller, kind: null, operation: null, workerOrigin: null, modelResidencyRoute: null,
      externalAttemptId: null, externalAccepted: false, externalOutputSequence: 0 };
    this.#active.set(jobId, active);
    try {
      const selected = await this.#jobs.executionInput({ jobId, ownerIdentityId });
      const asrConfiguration = this.#asr;
      active.ownerIdentityId = selected.job.ownerIdentityId;
      const chat = selected.job.operation === "chat.completions" && selected.job.model === this.#modelAlias
        && Array.isArray(selected.request?.messages);
      const drawing = drawingJobMatchesConfiguration(selected.job, selected.request, this.#drawing);
      const ocr = this.#ocr && selected.job.operation === "ocr" && selected.job.model === this.#ocr.modelAlias
        && UUID.test(selected.request?.input?.referenceId ?? "");
      const asr = asrConfiguration && selected.job.operation === "transcriptions" && selected.job.model === asrConfiguration.modelAlias
        && UUID.test(selected.request?.input?.referenceId ?? "");
      const translation = this.#translation && selected.job.operation === "translations" && selected.job.model === this.#translation.modelAlias
        && (typeof selected.request?.input?.text === "string" || UUID.test(selected.request?.input?.referenceId ?? ""));
      const embedding = this.#embedding && selected.job.operation === "embeddings" && selected.job.model === this.#embedding.modelAlias
        && (typeof selected.request?.input === "string" || Array.isArray(selected.request?.input));
      const externallyRoutable = this.#externalRouter && ((selected.job.operation === "chat.completions"
        && Array.isArray(selected.request?.messages)) || (new Set(["images.generations", "images.edits"]).has(selected.job.operation)
        && typeof selected.request?.prompt === "string") || (selected.job.operation === "ocr"
        && UUID.test(selected.request?.input?.referenceId ?? "")) || (this.#translation && selected.job.operation === "translations"
        && (typeof selected.request?.input?.text === "string" || UUID.test(selected.request?.input?.referenceId ?? ""))));
      if (!chat && !drawing && !ocr && !asr && !translation && !embedding && !externallyRoutable) {
        throw new PlatformError("compute_route_unavailable", "No certified worker route matches the queued request", { status: 409, retryable: true });
      }
      const localRoute = drawing ? this.#drawing.route : ocr ? this.#ocr.route : asr ? asrConfiguration.route
        : translation ? this.#translation.route : embedding ? this.#embedding.route : "local";
      const workerOrigin = drawing ? this.#drawing.origin : ocr ? this.#ocr.origin : asr ? asrConfiguration.origin
        : translation ? this.#translation.origin : embedding ? this.#embedding.origin : this.#origin;
      const healthPath = asr ? "/health/ready" : "/health";
      const health = embedding && this.#embedding.secure
        ? await this.#embedding.secure.transport.request({
          provider: this.#embedding.secure.provider,
          credential: this.#embedding.secure.credential,
          customCa: this.#embedding.secure.customCa,
          method: "GET", path: healthPath, timeoutMilliseconds: 5_000,
          signal: abortSignal(controller, 5_000),
        }).catch(() => null)
        : await this.#fetch(`${workerOrigin}${healthPath}`, {
          signal: abortSignal(controller, 5_000),
          ...(drawing && this.#drawing.bearerToken ? {
            headers: { authorization: `Bearer ${this.#drawing.bearerToken.toString("utf8")}` },
          } : {}),
        }).catch(() => null);
      const localHealthy = Boolean((chat || drawing || ocr || asr || translation || embedding)
        && (embedding && this.#embedding.secure ? health?.status >= 200 && health.status < 300 : health?.ok));
      const resolved = externallyRoutable
        ? await this.#externalRouter.resolve({ job: selected.job, request: selected.request, localAvailable: localHealthy })
        : null;
      const externalRoute = resolved?.selected ?? null;
      const kind = selected.job.operation === "translations" ? "translation" : selected.job.operation === "ocr" ? "ocr"
        : new Set(["images.generations", "images.edits"]).has(selected.job.operation) ? "drawing"
        : drawing ? "drawing" : ocr ? "ocr" : asr ? "asr" : embedding ? "embedding" : "chat";
      const route = externalRoute ? providerRouteKind(externalRoute) : localRoute;
      if (!externalRoute && !localHealthy) {
        throw new PlatformError("compute_worker_unavailable", "No healthy model worker route is available", { status: 503, retryable: true });
      }
      active.kind = kind;
      active.operation = selected.job.operation;
      active.workerOrigin = externalRoute ? null : workerOrigin;
      active.externalRoute = externalRoute;
      if (!new Set(["preparing", "running"]).has(selected.job.status)) {
        await this.#jobs.markPreparing(jobId, externalRoute ? `${route}_preparing`
          : drawing ? "exclusive_worker_preparing" : ocr ? "ocr_pipeline_preparing"
            : asr ? "asr_model_preparing" : translation ? "translation_workflow_preparing"
              : embedding ? "embedding_model_preparing" : "worker_preparing", route);
      }
      if (externalRoute && !await this.#externalRouter.probe(externalRoute, abortSignal(controller, 5_000))) {
        throw new PlatformError("compute_worker_unavailable", "The selected provider is not ready", { status: 503, retryable: true });
      }
      if (externalRoute?.provider?.resourceControl) {
        if (typeof this.#externalRouter.prepareModel !== "function"
            || typeof this.#externalRouter.releaseModel !== "function") {
          throw new PlatformError("compute_worker_unavailable", "The selected Provider cannot control model residency", { status: 503, retryable: true });
        }
        try {
          const residency = await this.#externalRouter.prepareModel(externalRoute, abortSignal(controller, this.#timeout), {
            jobId: selected.job.jobId, ownerIdentityId: selected.job.ownerIdentityId,
          });
          if (residency?.controlled !== true || residency.loaded !== true) throw new Error("provider_model_not_loaded");
          active.modelResidencyRoute = externalRoute;
        } catch (error) {
          throw new PlatformError("compute_worker_unavailable", "The selected Provider could not prepare the model", {
            cause: error, status: 503, retryable: true,
          });
        }
      }
      if (drawing && !externalRoute) {
        const prepared = await this.#fetch(`${workerOrigin}/v1/models/prepare`, {
          method: "POST", signal: abortSignal(controller, this.#timeout),
          headers: { accept: "application/json", "content-length": "0",
            "x-teamaibox-owner": selected.job.ownerIdentityId,
            ...(this.#drawing.bearerToken ? {
              authorization: `Bearer ${this.#drawing.bearerToken.toString("utf8")}`,
            } : {}) },
        }).catch(() => null);
        if (!prepared?.ok) throw new PlatformError("compute_worker_unavailable", "The drawing model could not be prepared", { status: 503, retryable: true });
      }
      let externalAttempt = null;
      if (externalRoute?.routeKind === "external_provider" && selected.job.operation === "chat.completions"
          && this.#externalAttempts) {
        const executionContract = externalRoute.provider.executionContract ?? {};
        externalAttempt = await this.#externalAttempts.begin({
          attemptId: randomUUID(), jobId: selected.job.jobId,
          ownerIdentityId: selected.job.ownerIdentityId,
          providerId: externalRoute.provider.providerId,
          modelProfileId: externalRoute.mapping.modelProfileId,
          providerModel: externalRoute.mapping.providerModelName,
          requestDigest: selected.job.requestDigest,
          idempotencyKey: executionContract.idempotencyMode === "provider_key"
            ? `taib:${selected.job.jobId}:${externalRoute.provider.providerId}` : null,
          replayContract: executionContract,
          startedAt: new Date(),
        });
        active.externalAttemptId = externalAttempt.attemptId;
      }
      let localAttempt = null;
      if (!externalRoute && this.#localAttempts) {
        const binding = drawing ? this.#drawing : ocr ? this.#ocr : asr ? this.#asr
          : translation ? this.#translation : embedding ? this.#embedding : this.#localWorker;
        localAttempt = await this.#localAttempts.begin({
          attemptId: randomUUID(), jobId: selected.job.jobId, ownerIdentityId: selected.job.ownerIdentityId,
          modelProfileId: binding.profileId, workerId: binding.workerId, route: binding.route,
          startedAt: new Date(), executionTimeoutMilliseconds: this.#timeout,
        });
        if (localAttempt?.admitted !== true) {
          throw new PlatformError("compute_local_worker_busy", "The protected local worker is already executing another request", {
            status: 409, retryable: true,
          });
        }
        active.deadlineTimer = setTimeout(() => controller.abort(), this.#timeout);
        active.deadlineTimer.unref?.();
      }
      if (selected.job.status !== "running" && !externalAttempt && !localAttempt) await this.#jobs.markRunning(jobId);
      return { selected, controller, kind, workerOrigin: externalRoute ? null : workerOrigin, externalRoute,
        modelResidencyRoute: active.modelResidencyRoute,
        externalAttemptId: active.externalAttemptId,
        servedModel: externalRoute?.mapping.providerModelName ?? null };
    } catch (error) {
      clearTimeout(active.deadlineTimer);
      if (active.modelResidencyRoute) this.#externalRouter.releaseModel(active.modelResidencyRoute);
      if (error?.code !== "compute_local_worker_busy") await this.#recordFailure(jobId, error, controller);
      this.#active.delete(jobId);
      throw error;
    }
  }

  async #observeExternalOutput(prepared, body, providerRequestId = null) {
    if (!prepared.externalAttemptId || !this.#externalAttempts) return;
    const active = this.#active.get(prepared.selected.job.jobId);
    if (!active) throw new PlatformError("compute_external_attempt_missing", "External attempt state is unavailable", { status: 500 });
    const acceptedId = typeof providerRequestId === "string" && providerRequestId.length > 0
      ? providerRequestId : typeof body?.id === "string" && body.id.length > 0 ? body.id : null;
    if (!active.externalAccepted) {
      if (!acceptedId) {
        throw new PlatformError("compute_external_acceptance_missing", "Provider output has no acceptance identifier", { status: 502 });
      }
      await this.#externalAttempts.markAccepted(prepared.externalAttemptId, {
        providerRequestId: acceptedId, acceptedAt: new Date(),
      });
      active.externalAccepted = true;
    }
    const bytes = Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
    try {
      active.externalOutputSequence += 1;
      await this.#externalAttempts.observeOutput(prepared.externalAttemptId, {
        sequence: active.externalOutputSequence,
        sizeBytes: bytes.byteLength,
        sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        observedAt: new Date(),
      });
    } finally {
      bytes.fill(0);
    }
  }

  async #recordFailure(jobId, error, controller = this.#active.get(jobId)?.controller) {
    if ((controller?.signal.aborted || this.#active.get(jobId)?.cancelRequested === true) && this.#jobs.acknowledgeCancellation) {
      await this.#jobs.acknowledgeCancellation(jobId).catch(() => {});
      return;
    }
    await this.#jobs.fail(jobId, {
      code: typeof error?.code === "string" && /^[a-z][a-z0-9_.-]{1,127}$/.test(error.code) ? error.code : "compute_worker_failed",
      message: "The queued model execution could not be completed",
      retryClassification: error?.retryable === true ? "retryable" : "terminal",
      guidanceKey: error?.retryable === true ? "tasks.compute.retry_later" : "tasks.compute.failed",
      retryAction: error?.retryable === true ? "retry" : null,
    }).catch(() => {});
  }

  async #awaitDrawing({ selected, controller, workerOrigin, externalRoute, servedModel }) {
    const edit = selected.job.operation === "images.edits";
    const routeModel = servedModel ?? this.#drawing?.servedModel;
    if (typeof routeModel !== "string" || !routeModel) {
      throw new PlatformError("compute_route_unavailable", "The drawing route has no model mapping", { status: 409 });
    }
    const editRequest = edit ? await drawingEditRequest({
      request: selected.request, servedModel: routeModel,
      jobId: selected.job.jobId, ownerIdentityId: selected.job.ownerIdentityId, objects: this.#objects,
    }) : null;
    const requestBody = editRequest?.body ?? drawingRequest(selected.request, routeModel, selected.job.jobId);
    const path = edit ? "/images/edits" : "/images/generations";
    const response = externalRoute
      ? await this.#externalRouter.request(externalRoute, {
        method: "POST", path, body: requestBody,
        timeoutMilliseconds: this.#timeout, signal: abortSignal(controller, this.#timeout),
      })
      : await this.#fetch(`${workerOrigin}/v1${path}`, {
        method: "POST", signal: abortSignal(controller, this.#timeout),
        headers: { accept: "application/json", "content-type": "application/json",
          "x-teamaibox-owner": selected.job.ownerIdentityId,
          ...(this.#drawing.bearerToken ? {
            authorization: `Bearer ${this.#drawing.bearerToken.toString("utf8")}`,
          } : {}) }, body: JSON.stringify(requestBody),
      });
    if (externalRoute ? response.status < 200 || response.status >= 300 : !response.ok) throw workerFailure(response.status);
    const body = externalRoute ? response.body : await response.json().catch(() => null);
    const facts = body?.x_teamaibox;
    const format = imageFormat(facts?.output_format);
    if (!body || typeof body !== "object" || !Array.isArray(body.data) || body.data.length < 1 || body.data.length > 10
        || !format || !Number.isSafeInteger(facts?.seed) || facts.seed < 0 || facts.seed > 4_294_967_295
        || !Number.isSafeInteger(facts?.width) || facts.width < 1 || facts.width > 16_384
        || !Number.isSafeInteger(facts?.height) || facts.height < 1 || facts.height > 16_384
        || !Number.isSafeInteger(facts?.steps) || facts.steps < 1 || !Number.isFinite(facts?.guidance_scale)) {
      throw new PlatformError("compute_worker_invalid", "The drawing worker returned an invalid response", { status: 502 });
    }
    const outputs = [];
    for (const [index, image] of body.data.entries()) {
      const bytes = imageBytes(image?.b64_json);
      try {
        const digest = createHash("sha256").update(bytes).digest("hex");
        const stored = await this.#objects.storeOutput({
          actorIdentityId: selected.job.ownerIdentityId,
          objectKey: `ai-results/drawing/${selected.job.jobId}/${index + 1}.${format.extension}`,
          contentType: format.mediaType,
          content: bytes,
          expectedSha256: digest,
        });
        const reference = await this.#objects.issue({
          actorIdentityId: selected.job.ownerIdentityId,
          objectId: stored.objectId,
          objectVersion: stored.version,
          audience: "compute.user-result",
          operations: ["head", "read", "range"],
          expiresInSeconds: 900,
        });
        const path = `/api/v1/objects/references/${reference.referenceId}/content`;
        outputs.push(Object.freeze({
          reference_id: reference.referenceId,
          object_id: stored.objectId,
          object_version: stored.version,
          media_type: format.mediaType,
          size_bytes: stored.size,
          sha256: digest,
          width: facts.width,
          height: facts.height,
          encrypted: true,
          preview_path: path,
          download_path: `${path}?download=1`,
          saved_file_id: null,
        }));
      } finally {
        bytes.fill(0);
      }
    }
    const externalDocument = externalRoute?.profile?.document ?? null;
    const profileEvidence = externalRoute ? {
      profileId: externalRoute.profile.profileId,
      profileKey: externalDocument?.profileKey,
      profileFingerprint: externalRoute.profile.fingerprint,
      engineImageDigest: externalDocument?.engine?.imageDigest,
    } : {
      profileId: this.#drawing?.profileId,
      profileKey: this.#drawing?.profileKey,
      profileFingerprint: this.#drawing?.profileFingerprint,
      engineImageDigest: this.#drawing?.engineImageDigest,
    };
    if (!UUID.test(profileEvidence.profileId ?? "") || typeof profileEvidence.profileKey !== "string"
        || !profileEvidence.profileKey || !SHA256.test(profileEvidence.profileFingerprint ?? "")
        || !SHA256.test(profileEvidence.engineImageDigest ?? "")) {
      throw new PlatformError("compute_worker_invalid", "The drawing route has incomplete model profile evidence", { status: 502 });
    }
    return this.#jobs.complete(selected.job.jobId, {
      resultSchema: "teamaibox.ai.image-result.v1",
      result: {
        schema: "teamaibox.ai.image-result.v1",
        job_id: selected.job.jobId,
        operation: selected.job.operation,
        prompt: selected.request.prompt,
        revised_prompt: body.data[0]?.revised_prompt ?? null,
        outputs,
        reproducibility: {
          preset_key: facts.preset_key ?? "drawing.balanced.v1",
          seed: facts.seed,
          size: `${facts.width}x${facts.height}`,
          steps: facts.steps,
          guidance_scale: facts.guidance_scale,
          strength: facts.strength ?? null,
          output_format: facts.output_format,
        },
        provenance: {
          request_digest: selected.job.requestDigest,
          model_profile_id: profileEvidence.profileId,
          profile_key: profileEvidence.profileKey,
          profile_fingerprint: profileEvidence.profileFingerprint,
          engine_image_digest: profileEvidence.engineImageDigest,
          route: externalRoute ? providerRouteKind(externalRoute) : this.#drawing.route,
          source_reference_id: editRequest?.sourceReferenceId ?? null,
          mask_reference_id: editRequest?.maskReferenceId ?? null,
          completed_at: new Date().toISOString(),
        },
      },
    });
  }

  async #awaitOcr({ selected, controller, workerOrigin, externalRoute, servedModel }) {
    const sourceReferenceId = selected.request.input.referenceId;
    const source = await this.#objects.download({
      actorIdentityId: selected.job.ownerIdentityId,
      referenceId: sourceReferenceId,
      audience: "compute:ocr",
    });
    const mediaType = source?.metadata?.contentType;
    const fileType = mediaType === "application/pdf" ? 0 : new Set(["image/png", "image/jpeg", "image/webp"]).has(mediaType) ? 1 : null;
    if (!Buffer.isBuffer(source?.content) || source.content.byteLength < 1 || fileType === null) {
      source?.content?.fill?.(0);
      throw new PlatformError("compute_artifact_input_invalid", "OCR input bytes or media type are invalid", { status: 400 });
    }
    let response;
    try {
      const localRequestBody = { file: source.content.toString("base64"), fileType };
      const managedRequestBody = {
        model: servedModel ?? this.#ocr.servedModel,
        job_id: selected.job.jobId,
        ...localRequestBody,
        useLayoutDetection: true,
        formatBlockContent: selected.request.outputFormat === "markdown",
        layoutShapeMode: "rect",
        returnMarkdownImages: false,
        visualize: false,
        language_hints: selected.request.languageHints,
      };
      const managedLocal = !externalRoute && this.#ocr.protocol === "hunyuan-managed-v1";
      const requestBody = externalRoute || managedLocal ? managedRequestBody : localRequestBody;
      response = externalRoute
        ? await this.#externalRouter.request(externalRoute, {
          method: "POST", path: "/ocr", body: requestBody,
          timeoutMilliseconds: this.#timeout, signal: abortSignal(controller, this.#timeout),
        })
        : await this.#fetch(`${workerOrigin}${managedLocal ? "/ocr" : "/layout-parsing"}`, {
          method: "POST", signal: abortSignal(controller, this.#timeout),
          headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(requestBody),
        });
    } finally {
      source.content.fill(0);
    }
    if (externalRoute ? response.status < 200 || response.status >= 300 : !response.ok) throw workerFailure(response.status);
    const body = externalRoute ? response.body : await boundedJson(response);
    if (body?.errorCode !== 0 || !body?.result) {
      throw new PlatformError("compute_worker_invalid", "The OCR worker returned an unsuccessful result", { status: 502 });
    }
    const pages = ocrPages(body);
    const markdown = body.result.layoutParsingResults.map((page) => page?.markdown?.text)
      .filter((value) => typeof value === "string" && value.length).join("\n\n");
    const fallback = pages.map((page) => page.blocks.map((block) => block.text).join("\n")).join("\n\n");
    const text = markdown || fallback;
    if (Buffer.byteLength(text, "utf8") > bufferedMediaBytes()) {
      throw new PlatformError("media_memory_unavailable", "当前处理服务没有足够的可用内存保存识别结果，请稍后重试或增加处理资源。", { status: 503, retryable: true });
    }
    const output = ocrArtifactBytes({ format: selected.request.outputFormat, text, pages });
    try {
      const digest = createHash("sha256").update(output.bytes).digest("hex");
      const stored = await this.#objects.storeOutput({
        actorIdentityId: selected.job.ownerIdentityId,
        objectKey: `ai-results/ocr/${selected.job.jobId}/recognized.${output.extension}`,
        contentType: output.mediaType,
        content: output.bytes,
        expectedSha256: digest,
      });
      const reference = await this.#objects.issue({
        actorIdentityId: selected.job.ownerIdentityId,
        objectId: stored.objectId,
        objectVersion: stored.version,
        audience: "compute.user-result",
        operations: ["head", "read", "range"],
        expiresInSeconds: 900,
      });
      const completedAt = new Date().toISOString();
      const externalDocument = externalRoute?.profile?.document ?? null;
      const profileEvidence = externalRoute ? {
        modelKey: servedModel,
        profileId: externalRoute.profile.profileId,
        profileKey: externalDocument?.profileKey,
        profileFingerprint: externalRoute.profile.fingerprint,
        engineImageDigest: externalDocument?.engine?.imageDigest,
      } : {
        modelKey: this.#ocr.servedModel,
        profileId: this.#ocr.profileId,
        profileKey: this.#ocr.profileKey,
        profileFingerprint: this.#ocr.profileFingerprint,
        engineImageDigest: this.#ocr.engineImageDigest,
      };
      if (!UUID.test(profileEvidence.profileId ?? "") || typeof profileEvidence.profileKey !== "string"
          || !profileEvidence.profileKey || !SHA256.test(profileEvidence.profileFingerprint ?? "")
          || !SHA256.test(profileEvidence.engineImageDigest ?? "")) {
        throw new PlatformError("compute_worker_invalid", "The OCR route has incomplete model profile evidence", { status: 502 });
      }
      return this.#jobs.complete(selected.job.jobId, {
        resultSchema: "teamaibox.ai.ocr-result.v1",
        result: {
          schema: "teamaibox.ai.ocr-result.v1",
          job_id: selected.job.jobId,
          text,
          pages,
          artifacts: [{
            schemaVersion: 1,
            artifactId: randomUUID(),
            relationship: "output",
            label: `recognized.${output.extension}`,
            dataClass: selected.job.dataClass ?? "internal",
            object: { objectId: stored.objectId, objectVersion: stored.version, referenceId: reference.referenceId },
            mediaType: output.mediaType,
            sizeBytes: stored.size,
            integrity: { algorithm: "sha256", digest },
            lifecycleState: "verified",
            createdAt: completedAt,
            extensions: { encrypted: true },
          }],
          extensions: {
            output_format: selected.request.outputFormat,
            language_hints: selected.request.languageHints,
            provenance: {
              source_reference_id: sourceReferenceId,
              model_key: profileEvidence.modelKey,
              profile_id: profileEvidence.profileId,
              profile_key: profileEvidence.profileKey,
              profile_fingerprint: profileEvidence.profileFingerprint,
              engine_image_digest: profileEvidence.engineImageDigest,
              route: externalRoute ? providerRouteKind(externalRoute) : this.#ocr.route,
              request_digest: selected.job.requestDigest,
              completed_at: completedAt,
            },
          },
        },
      });
    } finally {
      output.bytes.fill(0);
    }
  }

  async #awaitAsr({ selected, controller, workerOrigin }) {
    const asr = this.#asr;
    const sourceReferenceId = selected.request.input.referenceId;
    const source = await this.#objects.download({ actorIdentityId: selected.job.ownerIdentityId,
      referenceId: sourceReferenceId, audience: "compute:asr" });
    const mediaType = source?.metadata?.contentType;
    const media = asrMedia(mediaType);
    if (!Buffer.isBuffer(source?.content) || source.content.byteLength < 1
        || !media) {
      source?.content?.fill?.(0);
      throw new PlatformError("compute_artifact_input_invalid", "ASR input bytes or media type are invalid", { status: 400 });
    }
    if (this.#active.get(selected.job.jobId)?.cancelRequested === true) {
      throw new PlatformError("compute_cancelled", "The ASR job was cancelled before worker dispatch", { status: 409 });
    }
    let result;
    try {
        const multipart = asrMultipart({ content: source.content, mediaType, extension: media.extension,
          modelName: asr.servedModel, language: selected.request.language,
          timestampGranularities: selected.request.timestampGranularities });
        let response;
        try {
          response = await this.#fetch(`${workerOrigin}/v1/audio/transcriptions`, { method: "POST",
            signal: abortSignal(controller, this.#timeout), headers: { accept: "application/json",
              "content-type": multipart.contentType, "content-length": String(multipart.body.byteLength) }, body: multipart.body });
        } finally { multipart.body.fill(0); }
        if (!response.ok) throw workerFailure(response.status);
        const body = await boundedJson(response);
        const text = body?.text; const language = body?.language; const duration = Number(body?.duration);
        if (typeof text !== "string"
            || typeof language !== "string" || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language)
            || !Number.isFinite(duration) || duration < 0) {
          throw new PlatformError("compute_worker_invalid", "The ASR worker returned invalid transcript metadata", { status: 502 });
        }
        result = {
          schema: "teamaibox.ai.asr-result.v1", job_id: selected.job.jobId, text,
          segments: asrSegments(body), language: { code: language, requested: selected.request.language ?? null },
          duration_seconds: duration,
          speaker_information: { requested: selected.request.speakerInformation, supported: false, speaker_count: null },
          provenance: { source_reference_id: sourceReferenceId, model_key: asr.servedModel,
            profile_id: asr.profileId, profile_key: asr.profileKey,
            profile_fingerprint: asr.profileFingerprint, engine_image_digest: asr.engineImageDigest,
            request_digest: selected.job.requestDigest, completed_at: new Date().toISOString(),
            route: asr.route, certification_state: 'certified' },
        };
      if (this.#active.get(selected.job.jobId)?.cancelRequested === true) {
        throw new PlatformError("compute_cancelled", "The cancelled ASR worker result was discarded", { status: 409 });
      }
    } finally { source.content.fill(0); }
    const completedAt = result.provenance.completed_at ?? new Date().toISOString();
    const output = asrArtifactBytes({ format: selected.request.outputFormat, result });
    try {
      const digest = createHash("sha256").update(output.bytes).digest("hex");
      const stored = await this.#objects.storeOutput({
        actorIdentityId: selected.job.ownerIdentityId,
        objectKey: `ai-results/asr/${selected.job.jobId}/transcript.${output.extension}`,
        contentType: output.mediaType,
        content: output.bytes,
        expectedSha256: digest,
      });
      const reference = await this.#objects.issue({
        actorIdentityId: selected.job.ownerIdentityId,
        objectId: stored.objectId,
        objectVersion: stored.version,
        audience: "compute.user-result",
        operations: ["head", "read", "range"],
        expiresInSeconds: 900,
      });
      result.artifacts = [{
        schemaVersion: 1,
        artifactId: randomUUID(),
        relationship: "output",
        label: `transcript.${output.extension}`,
        dataClass: selected.job.dataClass ?? "internal",
        object: { objectId: stored.objectId, objectVersion: stored.version, referenceId: reference.referenceId },
        mediaType: output.mediaType,
        sizeBytes: stored.size,
        integrity: { algorithm: "sha256", digest },
        lifecycleState: "verified",
        createdAt: completedAt,
        extensions: { encrypted: true },
      }];
      return this.#jobs.complete(selected.job.jobId, { resultSchema: result.schema, result });
    } finally {
      output.bytes.fill(0);
    }
  }

  async #translationInput(selected, controller) {
    const request = selected.request;
    if (request.inputKind === "text") {
      return { segments: [{ id: "segment-1", startMs: null, endMs: null, text: request.input.text }], intermediates: [] };
    }
    const sourceReferenceId = request.input.referenceId;
    const source = await this.#objects.download({
      actorIdentityId: selected.job.ownerIdentityId,
      referenceId: sourceReferenceId,
      audience: "compute:translation",
    });
    const content = source?.content;
    const mediaType = String(source?.metadata?.contentType ?? "").split(";", 1)[0].trim().toLowerCase();
    if (!Buffer.isBuffer(content) || content.byteLength < 1) {
      content?.fill?.(0);
      throw new PlatformError("compute_artifact_input_invalid", "Translation input bytes are invalid", { status: 400 });
    }
    let extracted;
    try {
      if (request.inputRepresentation === "ocr-result" || request.inputRepresentation === "asr-result") {
        if (mediaType !== "application/json") {
          throw new PlatformError("compute_artifact_input_invalid", "Translation handoff result must be protected JSON", { status: 400 });
        }
        let value;
        try { value = JSON.parse(content.toString("utf8")); }
        catch { throw new PlatformError("compute_artifact_input_invalid", "Translation handoff JSON is invalid", { status: 400 }); }
        if (request.inputRepresentation === "ocr-result") {
          const blocks = Array.isArray(value?.pages) ? value.pages.flatMap((page) => page?.blocks ?? []) : [];
          const segments = blocks.filter((block) => typeof block?.text === "string" && block.text.length)
            .map((block, index) => ({ id: String(block.id ?? `segment-${index + 1}`), startMs: null, endMs: null, text: block.text }));
          extracted = { segments: segments.length ? segments : [{ id: "segment-1", startMs: null, endMs: null, text: value?.text }], intermediates: [] };
        } else {
          const segments = Array.isArray(value?.segments) ? value.segments.map((segment, index) => ({
            id: String(segment?.id ?? `segment-${index + 1}`),
            startMs: Math.round(Number(segment?.start_seconds) * 1_000),
            endMs: Math.round(Number(segment?.end_seconds) * 1_000),
            text: segment?.text,
          })) : [];
          extracted = { segments, intermediates: [] };
        }
      } else if (new Set(["image", "document"]).has(request.inputKind)) {
        if (!this.#ocr) throw new PlatformError("compute_route_unavailable", "OCR is unavailable for this translation workflow", { status: 409, retryable: true });
        const fileType = mediaType === "application/pdf" ? 0 : new Set(["image/png", "image/jpeg", "image/webp"]).has(mediaType) ? 1 : null;
        if (fileType === null) throw new PlatformError("compute_artifact_input_invalid", "Translation document media type is unsupported", { status: 400 });
        const localRequestBody = { file: content.toString("base64"), fileType };
        const localHealth = await this.#fetch(`${this.#ocr.origin}/health`, {
          signal: abortSignal(controller, 5_000),
        }).catch(() => null);
        const nested = this.#externalRouter?.resolveCapability
          ? await this.#externalRouter.resolveCapability({ parentJob: selected.job, capabilityKey: "ocr",
            operation: "ocr", request, localAvailable: Boolean(localHealth?.ok) })
          : null;
        const externalOcr = nested?.selected ?? null;
        let response;
        if (externalOcr) {
          if (!await this.#externalRouter.probe(externalOcr, abortSignal(controller, 5_000))) {
            throw new PlatformError("compute_worker_unavailable", "The selected OCR provider is not ready", { status: 503, retryable: true });
          }
          response = await this.#externalRouter.request(externalOcr, {
            method: "POST", path: "/ocr",
            body: {
              model: externalOcr.mapping.providerModelName,
              job_id: selected.job.jobId,
              ...localRequestBody,
              useLayoutDetection: true,
              formatBlockContent: true,
              layoutShapeMode: "rect",
              returnMarkdownImages: false,
              visualize: false,
            },
            timeoutMilliseconds: this.#timeout, signal: abortSignal(controller, this.#timeout),
          });
        } else {
          const managedLocal = this.#ocr.protocol === "hunyuan-managed-v1";
          response = await this.#fetch(`${this.#ocr.origin}${managedLocal ? "/ocr" : "/layout-parsing"}`, {
            method: "POST", signal: abortSignal(controller, this.#timeout),
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify(managedLocal ? {
              model: this.#ocr.servedModel,
              job_id: selected.job.jobId,
              ...localRequestBody,
              useLayoutDetection: true,
              formatBlockContent: true,
              layoutShapeMode: "rect",
              returnMarkdownImages: false,
              visualize: false,
            } : localRequestBody),
          });
        }
        if (externalOcr ? response.status < 200 || response.status >= 300 : !response.ok) throw workerFailure(response.status);
        const body = externalOcr ? response.body : await boundedJson(response);
        if (body?.errorCode !== 0 || !body?.result) throw new PlatformError("compute_worker_invalid", "OCR translation stage failed", { status: 502 });
        const pages = ocrPages(body);
        const segments = pages.flatMap((page) => page.blocks.map((block) => ({
          id: block.id, startMs: null, endMs: null, text: block.text,
        })));
        const externalProfile = externalOcr?.profile?.document ?? null;
        const ocrProfile = {
          profileKey: externalProfile?.profileKey ?? this.#ocr.profileKey,
          route: externalOcr ? providerRouteKind(externalOcr) : this.#ocr.route,
        };
        const intermediateBytes = Buffer.from(JSON.stringify({ schema: "teamaibox.ai.ocr-result.v1",
          text: segments.map((item) => item.text).join("\n"), pages,
          provenance: { source_reference_id: sourceReferenceId, profile_key: ocrProfile.profileKey,
            route: ocrProfile.route, provider_id: externalOcr?.provider?.providerId ?? null } }), "utf8");
        try {
          const stored = await this.#objects.storeOutput({ actorIdentityId: selected.job.ownerIdentityId,
            objectKey: `ai-results/translation/${selected.job.jobId}/ocr-intermediate.json`, contentType: "application/json",
            content: intermediateBytes, expectedSha256: createHash("sha256").update(intermediateBytes).digest("hex") });
          const reference = await this.#objects.issue({ actorIdentityId: selected.job.ownerIdentityId, objectId: stored.objectId,
            objectVersion: stored.version, audience: "compute.user-result", operations: ["head", "read", "range"], expiresInSeconds: 900 });
          extracted = { segments, intermediates: [{ kind: "ocr-text", reference_id: reference.referenceId }],
            profiles: { ocr: ocrProfile } };
        } finally { intermediateBytes.fill(0); }
      } else if (new Set(["audio", "video"]).has(request.inputKind)) {
        if (!this.#asr) throw new PlatformError("compute_route_unavailable", "ASR is unavailable for this translation workflow", { status: 409, retryable: true });
        const media = asrMedia(mediaType);
        if (!media) throw new PlatformError("compute_artifact_input_invalid", "Translation media type is unsupported", { status: 400 });
        const multipart = asrMultipart({ content, mediaType, extension: media.extension, modelName: this.#asr.servedModel,
          language: request.sourceLanguage, timestampGranularities: ["segment"] });
        let response;
        try {
          response = await this.#fetch(`${this.#asr.origin}/v1/audio/transcriptions`, { method: "POST",
            signal: abortSignal(controller, this.#timeout), headers: { accept: "application/json", "content-type": multipart.contentType,
              "content-length": String(multipart.body.byteLength) }, body: multipart.body });
        } finally { multipart.body.fill(0); }
        if (!response.ok) throw workerFailure(response.status);
        const body = await boundedJson(response);
        const asr = asrSegments(body);
        const segments = asr.map((segment) => ({ id: segment.id, startMs: Math.round(segment.start_seconds * 1_000),
          endMs: Math.round(segment.end_seconds * 1_000), text: segment.text }));
        const intermediateBytes = Buffer.from(JSON.stringify({ schema: "teamaibox.ai.asr-result.v1", text: body.text,
          segments: asr, language: { code: body.language }, duration_seconds: body.duration }), "utf8");
        try {
          const stored = await this.#objects.storeOutput({ actorIdentityId: selected.job.ownerIdentityId,
            objectKey: `ai-results/translation/${selected.job.jobId}/asr-intermediate.json`, contentType: "application/json",
            content: intermediateBytes, expectedSha256: createHash("sha256").update(intermediateBytes).digest("hex") });
          const reference = await this.#objects.issue({ actorIdentityId: selected.job.ownerIdentityId, objectId: stored.objectId,
            objectVersion: stored.version, audience: "compute.user-result", operations: ["head", "read", "range"], expiresInSeconds: 900 });
          extracted = { segments, intermediates: [{ kind: "asr-transcript", reference_id: reference.referenceId }],
            profiles: { asr: { profileKey: this.#asr.profileKey, route: this.#asr.route } } };
        } finally { intermediateBytes.fill(0); }
      }
    } finally { content.fill(0); }
    if (!Array.isArray(extracted?.segments) || extracted.segments.length < 1
        || extracted.segments.some((item) => typeof item.text !== "string" || !item.text.length
          || (item.startMs !== null && (!Number.isSafeInteger(item.startMs) || !Number.isSafeInteger(item.endMs) || item.endMs < item.startMs)))) {
      throw new PlatformError("compute_artifact_input_invalid", "Translation source segments are invalid", { status: 400 });
    }
    return extracted;
  }

  async #awaitTranslation({ selected, controller, workerOrigin, externalRoute, servedModel }) {
    const input = await this.#translationInput(selected, controller);
    // JSON mode alone permits an arbitrary object (or an unfinished sequence).
    // The resident LMT4 runtime supports constrained JSON Schema generation:
    // require exactly one translated string per source segment. Keep the
    // existing external-provider contract; not every provider supports schema.
    const responseFormat = externalRoute ? { type: "json_object" } : {
      type: "json_schema", json_schema: { name: "aligned_translation", strict: true, schema: {
        type: "object", properties: {
          source_language: { type: "string" },
          translations: { type: "array", items: { type: "string" },
            minItems: input.segments.length, maxItems: input.segments.length },
        }, required: ["source_language", "translations"], additionalProperties: false,
      } },
    };
    const requestBody = { model: servedModel ?? this.#translation.servedModel, stream: false, temperature: 0,
        response_format: responseFormat, chat_template_kwargs: { enable_thinking: false }, messages: [
          { role: "system", content: "You are a precise translation engine. Return only JSON: {\"source_language\":\"BCP-47\",\"translations\":[\"...\"]}. Preserve the input array length and order. Preserve every number, measurement, code, product name, and Latin-script proper noun exactly. Do not add commentary." },
          { role: "user", content: JSON.stringify({ source_language: selected.request.sourceLanguage ?? "auto",
            target_language: selected.request.targetLanguage, segments: input.segments.map((segment) => segment.text) }) },
        ] };
    const response = externalRoute
      ? await this.#externalRouter.request(externalRoute, {
        method: "POST", path: "/chat/completions", body: requestBody,
        timeoutMilliseconds: this.#timeout, signal: abortSignal(controller, this.#timeout),
      })
      : await this.#fetch(`${workerOrigin}/v1/chat/completions`, {
        method: "POST", signal: abortSignal(controller, this.#timeout),
        headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(requestBody),
      });
    if (externalRoute ? response.status < 200 || response.status >= 300 : !response.ok) throw workerFailure(response.status);
    const body = externalRoute ? response.body : await boundedJson(response);
    const translated = translationCompletion(body, input.segments.length, selected.request.sourceLanguage);
    const completedAt = new Date().toISOString();
    const sourceReferenceId = selected.request.input.referenceId ?? null;
    const segments = input.segments.map((segment, index) => ({ id: segment.id, start_ms: segment.startMs,
      end_ms: segment.endMs, source_text: segment.text, translated_text: translated.translations[index],
      source_reference_id: sourceReferenceId }));
    const stages = selected.request.workflow.map((stage) => ({ stage_id: stage.stageId, capability: stage.capabilityKey,
      status: "succeeded", profile_key: stage.capabilityKey === "translation" ? this.#translation.profileKey
        : stage.capabilityKey === "ocr" ? input.profiles?.ocr?.profileKey ?? this.#ocr?.profileKey ?? null
          : stage.capabilityKey === "asr" ? input.profiles?.asr?.profileKey ?? this.#asr?.profileKey ?? null : null,
      route: stage.capabilityKey === "ocr" ? input.profiles?.ocr?.route ?? null
        : stage.capabilityKey === "asr" ? input.profiles?.asr?.route ?? this.#asr?.route ?? null
          : stage.capabilityKey === "translation" ? externalRoute ? providerRouteKind(externalRoute) : this.#translation.route : null }));
    const result = { schema: "teamaibox.ai.translation-result.v1", job_id: selected.job.jobId,
      input_kind: selected.request.inputKind, source_language: translated.sourceLanguage,
      target_language: selected.request.targetLanguage, text: translated.translations.join("\n"), segments,
      usage: translated.usage,
      workflow: { stages, intermediates: selected.request.includeIntermediates ? input.intermediates : [] },
      provenance: { source_reference_id: sourceReferenceId, completed_at: completedAt } };
    const output = translationArtifactBytes({ format: selected.request.outputFormat, result });
    try {
      const digest = createHash("sha256").update(output.bytes).digest("hex");
      const stored = await this.#objects.storeOutput({ actorIdentityId: selected.job.ownerIdentityId,
        objectKey: `ai-results/translation/${selected.job.jobId}/translated.${output.extension}`, contentType: output.mediaType,
        content: output.bytes, expectedSha256: digest });
      const reference = await this.#objects.issue({ actorIdentityId: selected.job.ownerIdentityId, objectId: stored.objectId,
        objectVersion: stored.version, audience: "compute.user-result", operations: ["head", "read", "range"], expiresInSeconds: 900 });
      result.artifacts = [{ schemaVersion: 1, artifactId: randomUUID(), relationship: "output", label: `translated.${output.extension}`,
        dataClass: selected.job.dataClass ?? "internal", object: { objectId: stored.objectId, objectVersion: stored.version,
          referenceId: reference.referenceId }, mediaType: output.mediaType, sizeBytes: stored.size,
        integrity: { algorithm: "sha256", digest }, lifecycleState: "verified", createdAt: completedAt,
        extensions: { encrypted: true } }];
      return this.#jobs.complete(selected.job.jobId, { resultSchema: result.schema, result });
    } finally { output.bytes.fill(0); }
  }

  async #awaitEmbedding({ selected, controller, workerOrigin }) {
    const requestBody = {
      model: this.#embedding.servedModel,
      input: selected.request.input,
      encoding_format: "float",
    };
    let body;
    if (this.#embedding.secure) {
      const response = await this.#embedding.secure.transport.request({
        provider: this.#embedding.secure.provider,
        credential: this.#embedding.secure.credential,
        customCa: this.#embedding.secure.customCa,
        method: "POST", path: "/v1/embeddings", body: requestBody,
        timeoutMilliseconds: this.#timeout, signal: abortSignal(controller, this.#timeout),
      });
      if (response.status < 200 || response.status >= 300) throw workerFailure(response.status);
      body = response.body;
    } else {
      const response = await this.#fetch(`${workerOrigin}/v1/embeddings`, {
        method: "POST", signal: abortSignal(controller, this.#timeout),
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      if (!response.ok) throw workerFailure(response.status);
      body = await boundedJson(response);
    }
    const expected = Array.isArray(selected.request.input) ? selected.request.input.length : 1;
    if (!body || typeof body !== "object" || body.object !== "list" || !Array.isArray(body.data)
        || body.data.length !== expected || body.data.length < 1 || body.data.length > 2_048) {
      throw new PlatformError("compute_worker_invalid", "The embedding worker returned an invalid result list", { status: 502 });
    }
    const ordered = [...body.data].sort((left, right) => Number(left?.index) - Number(right?.index));
    let dimensions = null;
    for (const [index, item] of ordered.entries()) {
      if (!item || item.object !== "embedding" || item.index !== index || !Array.isArray(item.embedding)
          || item.embedding.length < 1 || item.embedding.length > 65_536
          || item.embedding.some((value) => !Number.isFinite(value))) {
        throw new PlatformError("compute_worker_invalid", "The embedding worker returned an invalid vector", { status: 502 });
      }
      dimensions ??= item.embedding.length;
      if (item.embedding.length !== dimensions) {
        throw new PlatformError("compute_worker_invalid", "The embedding worker returned inconsistent dimensions", { status: 502 });
      }
    }
    const requestedDimensions = selected.request.dimensions ?? dimensions;
    if (!Number.isSafeInteger(requestedDimensions) || requestedDimensions < 1 || requestedDimensions > dimensions) {
      throw new PlatformError("invalid_compute_request", "Requested embedding dimensions exceed the model capability", { status: 400 });
    }
    const encodingFormat = selected.request.encoding_format ?? "float";
    const projected = ordered.map((item) => {
      const values = item.embedding.slice(0, requestedDimensions);
      if (requestedDimensions !== dimensions) {
        const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
        if (!Number.isFinite(norm) || norm <= 0) {
          throw new PlatformError("compute_worker_invalid", "The embedding worker returned a non-normalizable vector", { status: 502 });
        }
        for (let index = 0; index < values.length; index += 1) values[index] /= norm;
      }
      if (encodingFormat === "float") return { object: "embedding", index: item.index, embedding: values };
      const bytes = Buffer.allocUnsafe(values.length * 4);
      for (let index = 0; index < values.length; index += 1) bytes.writeFloatLE(values[index], index * 4);
      try { return { object: "embedding", index: item.index, embedding: bytes.toString("base64") }; }
      finally { bytes.fill(0); }
    });
    const promptTokens = Number(body.usage?.prompt_tokens);
    const totalTokens = Number(body.usage?.total_tokens);
    if (!Number.isSafeInteger(promptTokens) || promptTokens < 0
        || !Number.isSafeInteger(totalTokens) || totalTokens < promptTokens) {
      throw new PlatformError("compute_worker_invalid", "The embedding worker returned invalid usage", { status: 502 });
    }
    return this.#jobs.complete(selected.job.jobId, {
      resultSchema: "openai.embedding-list.v1",
      result: {
        object: "list",
        model: this.#embedding.modelAlias,
        data: projected,
        usage: { prompt_tokens: promptTokens, total_tokens: totalTokens },
        x_teamaibox: {
          dimensions: requestedDimensions,
          source_dimensions: dimensions,
          encoding_format: encodingFormat,
          profile_id: this.#embedding.profileId,
          profile_key: this.#embedding.profileKey,
          profile_fingerprint: this.#embedding.profileFingerprint,
          engine_image_digest: this.#embedding.engineImageDigest,
        },
      },
    });
  }

  async dispatch({ jobId, ownerIdentityId }) {
    if (this.#active.has(jobId)) return false;
    try { await this.awaitResult({ jobId, ownerIdentityId }); } catch { /* durable job state records the failure */ }
    return true;
  }

  canDispatch(work) {
    return (work?.operation === "chat.completions" && work?.requestedModel === this.#modelAlias)
      || Boolean(this.#externalRouter && (work?.operation === "chat.completions"
        || new Set(["images.generations", "images.edits"]).has(work?.operation)
        || work?.operation === "ocr" || (this.#translation && work?.operation === "translations")))
      || Boolean(this.#drawing && new Set(["images.generations", "images.edits"]).has(work?.operation)
        && this.#drawing.acceptedModelAliases.includes(work?.requestedModel)
        && (!DRAWING_ORDINARY_ALIASES.has(work?.requestedModel)
          || work?.requestedModelProfileId?.toLowerCase() === this.#drawing.profileId.toLowerCase()))
      || Boolean(this.#ocr && work?.operation === "ocr" && work?.requestedModel === this.#ocr.modelAlias)
      || Boolean(this.#asr && work?.operation === "transcriptions" && work?.requestedModel === this.#asr.modelAlias)
      || Boolean(this.#translation && work?.operation === "translations" && work?.requestedModel === this.#translation.modelAlias)
      || Boolean(this.#embedding && work?.operation === "embeddings" && work?.requestedModel === this.#embedding.modelAlias);
  }

  async cancel(jobId) {
    const active = this.#active.get(jobId);
    if (!active) return false;
    if (active.kind === "asr") {
      active.cancelRequested = true;
      await this.#jobs.acknowledgeCancellation?.(jobId).catch(() => {});
      return true;
    }
    if (active.kind === "drawing") {
      const operation = active.operation === "images.edits" ? "edits" : "generations";
      let confirmed = false;
      if (active.workerOrigin) {
        const response = await this.#fetch(`${active.workerOrigin}/v1/images/${operation}/${jobId}/cancel`, {
          method: "POST", signal: AbortSignal.timeout(3_000),
          headers: { accept: "application/json", "content-length": "0",
            "x-teamaibox-owner": active.ownerIdentityId,
            ...(this.#drawing.bearerToken ? {
              authorization: `Bearer ${this.#drawing.bearerToken.toString("utf8")}`,
            } : {}) },
        }).catch(() => null);
        const body = response?.ok ? await response.json().catch(() => null) : null;
        confirmed = body?.cancelled === true && body?.job_id === jobId;
      } else if (active.externalRoute) {
        const response = await this.#externalRouter.request(active.externalRoute, {
          method: "POST", path: `/images/${operation}/${jobId}/cancel`, body: null,
          timeoutMilliseconds: 3_000, signal: AbortSignal.timeout(3_000),
        }).catch(() => null);
        confirmed = response?.status >= 200 && response.status < 300
          && response.body?.cancelled === true && response.body?.job_id === jobId;
      }
      if (!confirmed) return false;
      active.cancelRequested = true;
      active.controller.abort();
      return true;
    }
    if (active.kind === "ocr") {
      if (active.externalRoute) {
        await this.#externalRouter.request(active.externalRoute, {
          method: "POST", path: `/ocr/${jobId}/cancel`, body: null,
          timeoutMilliseconds: 3_000, signal: AbortSignal.timeout(3_000),
        }).catch(() => null);
      } else if (active.workerOrigin && this.#ocr.protocol === "hunyuan-managed-v1") {
        await this.#fetch(`${active.workerOrigin}/ocr/${jobId}/cancel`, {
          method: "POST", signal: AbortSignal.timeout(3_000),
          headers: { accept: "application/json", "content-length": "0" },
        }).catch(() => null);
      }
    }
    active.cancelRequested = true;
    active.controller.abort();
    return true;
  }

  async awaitResult({ jobId, ownerIdentityId }) {
    const prepared = await this.#prepare(jobId, ownerIdentityId);
    try {
      if (prepared.kind === "drawing") return await this.#awaitDrawing(prepared);
      if (prepared.kind === "ocr") return await this.#awaitOcr(prepared);
      if (prepared.kind === "asr") return await this.#awaitAsr(prepared);
      if (prepared.kind === "translation") return await this.#awaitTranslation(prepared);
      if (prepared.kind === "embedding") return await this.#awaitEmbedding(prepared);
      const { selected, controller, workerOrigin, externalRoute, servedModel } = prepared;
      const requestBody = workerRequest(selected.request, servedModel ?? this.#servedModel, false);
      const response = externalRoute
        ? await this.#externalRouter.request(externalRoute, {
          method: "POST", path: "/chat/completions", body: requestBody,
          timeoutMilliseconds: this.#timeout, signal: abortSignal(controller, this.#timeout),
        })
        : await this.#fetch(`${workerOrigin}/v1/chat/completions`, {
          method: "POST", signal: abortSignal(controller, this.#timeout),
          headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(requestBody),
        });
      if (externalRoute ? response.status < 200 || response.status >= 300 : !response.ok) throw workerFailure(response.status);
      const body = externalRoute ? response.body : await response.json().catch(() => null);
      if (!body || typeof body !== "object" || body.object !== "chat.completion" || !Array.isArray(body.choices)) {
        throw new PlatformError("compute_worker_invalid", "The model worker returned an invalid response", { status: 502 });
      }
      if (externalRoute) await this.#observeExternalOutput(prepared, body);
      return await this.#jobs.complete(jobId, { result: { ...body, model: this.#modelAlias }, resultSchema: "openai.chat.completion.v1" });
    } catch (error) {
      await this.#recordFailure(jobId, error, prepared.controller);
      throw error;
    } finally {
      if (prepared.modelResidencyRoute) this.#externalRouter.releaseModel(prepared.modelResidencyRoute);
      clearTimeout(this.#active.get(jobId)?.deadlineTimer);
      this.#active.delete(jobId);
    }
  }

  async streamResult({ jobId, ownerIdentityId }) {
    const self = this;
    return (async function* stream() {
      const prepared = await self.#prepare(jobId, ownerIdentityId);
      if (prepared.kind !== "chat") {
        await self.#recordFailure(jobId, new PlatformError("compute_route_unavailable", "The selected operation cannot stream", { status: 409 }), prepared.controller);
        clearTimeout(self.#active.get(jobId)?.deadlineTimer);
        self.#active.delete(jobId);
        throw new PlatformError("compute_route_unavailable", "The selected operation cannot stream", { status: 409 });
      }
      const { selected, controller, workerOrigin, externalRoute, servedModel } = prepared;
      let responseBody;
      let completed = false;
      let failureRecorded = false;
      const memoryReservations=[];
      try {
        const requestBody = workerRequest(selected.request, servedModel ?? self.#servedModel, true);
        const response = externalRoute
          ? await self.#externalRouter.stream(externalRoute, {
            method: "POST", path: "/chat/completions", body: requestBody,
            timeoutMilliseconds: self.#timeout, signal: abortSignal(controller, self.#timeout),
          })
          : await self.#fetch(`${workerOrigin}/v1/chat/completions`, {
            method: "POST", signal: abortSignal(controller, self.#timeout),
            headers: { accept: "text/event-stream", "content-type": "application/json" }, body: JSON.stringify(requestBody),
          });
        if ((externalRoute ? response.status < 200 || response.status >= 300 : !response.ok) || !response.body) {
          response.body?.destroy?.();
          throw workerFailure(response.status);
        }
        const contentType = externalRoute ? response.headers["content-type"] : response.headers.get("content-type");
        if (!(contentType ?? "").toLowerCase().startsWith("text/event-stream")) {
          response.body?.destroy?.();
          throw new PlatformError("compute_worker_invalid", "The model worker returned an invalid stream", { status: 502 });
        }
        responseBody = response.body;
        const decoder = new TextDecoder();
        let buffer = "", observedBytes = 0, doneMarker = false;
        const chunks = [];
        for await (const item of streamChunks(responseBody)) {
          if (doneMarker) break;
          const decoded = decoder.decode(item.value ?? new Uint8Array(), { stream: !item.done }).replaceAll("\r\n", "\n");
          observedBytes += Buffer.byteLength(decoded);
          if(decoded.length)memoryReservations.push(reserveBufferedMedia(Buffer.byteLength(decoded)));
          buffer += decoded;
          const parsed = records(buffer);
          buffer = parsed.remainder;
          for (const raw of parsed.values) {
            if (raw === "[DONE]") { doneMarker = true; break; }
            let value;
            try { value = JSON.parse(raw); } catch { throw new PlatformError("compute_worker_stream_json_invalid", "The model stream contained invalid JSON", { status: 502 }); }
            if (!value || typeof value !== "object" || value.object !== "chat.completion.chunk") {
              throw new PlatformError("compute_worker_stream_chunk_invalid", "The model stream contained an invalid chunk", { status: 502 });
            }
            if (externalRoute) await self.#observeExternalOutput(prepared, raw, value.id);
            const projected = { ...value, model: self.#modelAlias };
            chunks.push(projected);
            yield Object.freeze({ data: Object.freeze(projected) });
          }
          if (item.done) break;
        }
        if (!doneMarker) throw new PlatformError("compute_worker_stream_incomplete", "The model stream ended before completion", { status: 502, retryable: true });
        const final = finalChat({ chunks, requestedModel: self.#modelAlias });
        if (!final.choices[0].message.content && !final.choices[0].message.tool_calls?.length) {
          throw new PlatformError("compute_worker_empty", "The model worker returned no visible content or tool call", { status: 502 });
        }
        await self.#jobs.complete(jobId, { result: final, resultSchema: "openai.chat.completion.v1" });
        completed = true;
      } catch (error) {
        await self.#recordFailure(jobId, error, controller);
        failureRecorded = true;
        throw error;
      } finally {
        for(const release of memoryReservations)release();
        if (!completed) {
          await cancelStream(responseBody);
          if (!failureRecorded) {
            await self.#recordFailure(jobId, new PlatformError("compute_stream_abandoned", "The model stream consumer disconnected", { status: 503, retryable: true }), controller);
          }
        }
        clearTimeout(self.#active.get(jobId)?.deadlineTimer);
        self.#active.delete(jobId);
      }
    }());
  }

  close() {
    this.#drawing?.bearerToken?.fill(0);
    this.#embedding?.secure?.credential.fill(0);
    this.#embedding?.secure?.customCa.fill(0);
  }
}
