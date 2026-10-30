import { randomUUID } from "node:crypto";

import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const MODEL = /^[^\s\u0000-\u001f]{1,512}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESPONSE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const DATA_CLASSES = new Set(["public", "internal", "confidential", "restricted"]);
const JOB_STATES = new Set([
  "queued", "admitted", "preparing", "running", "succeeded", "failed",
  "cancelled", "expired", "incomplete",
]);
const JOB_ROUTES = new Set(["unassigned", "local", "managed_node", "external_provider"]);
const PHYSICAL_ROUTE_FIELDS = new Set([
  "container_address", "container_id", "endpoint", "endpoint_uri", "node_id",
  "provider_id", "worker_address", "worker_id",
]);
const REQUEST_EXTENSION_FIELDS = new Set([
  "background", "data_class", "priority", "deadline_at", "idempotency_key",
  "model_profile_id", "extensions",
]);
const DRAWING_MAIN_PROTECTED_PROFILE_ID = "06c9542e-4bf3-5f4f-a41e-c7768398e2ea";
const DRAWING_ORDINARY_ALIASES = new Set(["drawing.automatic", "drawing.fast"]);
const DRAWING_ADVANCED_SELECTIONS = Object.freeze({
  "drawing.high-quality": Object.freeze({
    operation: "images.generations",
    profileId: "c6799c69-7c01-5031-94c3-45d3785e7e43",
  }),
  "drawing.chinese-poster": Object.freeze({
    operation: "images.generations",
    profileId: "c6799c69-7c01-5031-94c3-45d3785e7e43",
  }),
  "drawing.edit": Object.freeze({
    operation: "images.edits",
    profileId: "bc266009-bf57-589e-b8c4-dcf9ec892692",
  }),
});

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function invalid(message, param = null) {
  throw new PlatformError("invalid_compute_request", message, {
    status: 400,
    details: param ? { param } : null,
  });
}

function rejectUnknown(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid("Unknown request field", key);
  }
}

function safeModel(value, { required = true } = {}) {
  if ((value === undefined || value === null) && !required) return null;
  if (typeof value !== "string" || !MODEL.test(value)) invalid("Model is invalid", "model");
  return value;
}

function safeBoolean(value, fallback = false, param = "value") {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") invalid(`${param} must be a boolean`, param);
  return value;
}

function safeLanguage(value, param, { required = false } = {}) {
  if ((value === undefined || value === null) && !required) return null;
  if (typeof value !== "string" || !LANGUAGE.test(value)) invalid(`${param} is invalid`, param);
  return value;
}

function safeIdempotencyKey(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) {
    invalid("Idempotency key is invalid", "idempotency_key");
  }
  return value;
}

function safeExtension(value) {
  if (value === undefined) return Object.freeze({
    background: false,
    dataClass: "internal",
    priority: 50,
    deadlineAt: null,
    idempotencyKey: null,
    modelProfileId: null,
    extensions: Object.freeze({}),
  });
  if (!record(value)) invalid("x_teamaibox must be an object", "x_teamaibox");
  for (const key of Object.keys(value)) {
    if (PHYSICAL_ROUTE_FIELDS.has(key)) {
      invalid("Physical worker, node, provider, container, or endpoint routing is not accepted", `x_teamaibox.${key}`);
    }
    if (!REQUEST_EXTENSION_FIELDS.has(key)) {
      invalid("Unknown Team AI Box request extension field", `x_teamaibox.${key}`);
    }
  }
  if (value.extensions !== undefined && !record(value.extensions)) {
    invalid("x_teamaibox.extensions must be an object", "x_teamaibox.extensions");
  }
  const dataClass = value.data_class ?? "internal";
  if (!DATA_CLASSES.has(dataClass)) invalid("Data class is invalid", "x_teamaibox.data_class");
  const priority = value.priority ?? 50;
  if (!Number.isInteger(priority) || priority < 0 || priority > 100) {
    invalid("Priority must be an integer from 0 through 100", "x_teamaibox.priority");
  }
  let deadlineAt = null;
  if (value.deadline_at !== undefined && value.deadline_at !== null) {
    deadlineAt = new Date(value.deadline_at);
    if (Number.isNaN(deadlineAt.getTime())) invalid("Deadline is invalid", "x_teamaibox.deadline_at");
  }
  let modelProfileId = null;
  if (value.model_profile_id !== undefined && value.model_profile_id !== null) {
    if (typeof value.model_profile_id !== "string" || !UUID.test(value.model_profile_id)) {
      invalid("Model profile identifier is invalid", "x_teamaibox.model_profile_id");
    }
    modelProfileId = value.model_profile_id;
  }
  return Object.freeze({
    background: safeBoolean(value.background, false, "x_teamaibox.background"),
    dataClass,
    priority,
    deadlineAt,
    idempotencyKey: safeIdempotencyKey(value.idempotency_key),
    modelProfileId,
    extensions: Object.freeze(structuredClone(value.extensions ?? {})),
  });
}

function idempotencyFrom(headers, extension) {
  const raw = headers?.["idempotency-key"];
  if (Array.isArray(raw)) invalid("Idempotency-Key must occur once", "idempotency-key");
  const header = safeIdempotencyKey(raw);
  if (header && extension.idempotencyKey && header !== extension.idempotencyKey) {
    invalid("Header and extension idempotency keys differ", "idempotency-key");
  }
  return header ?? extension.idempotencyKey;
}

function withoutExtension(body) {
  const request = structuredClone(body);
  delete request.x_teamaibox;
  return request;
}

function requestWithExtensions(body, extension) {
  const request = withoutExtension(body);
  if (Object.keys(extension.extensions).length > 0 || extension.drawingRouteAuthorization) {
    request.x_teamaibox = {
      extensions: structuredClone(extension.extensions),
      ...(extension.drawingRouteAuthorization
        ? { routing_authorization: structuredClone(extension.drawingRouteAuthorization) }
        : {}),
    };
  }
  return request;
}

function drawingProfileSelection({ context, operation, model, extension, drawingProfileId }) {
  if (!new Set(["images.generations", "images.edits"]).has(operation)) return extension;
  const advancedAuthorized = context?.permissions?.some((permission) => permission === "model:view"
    || permission === "model:manage") === true;
  const requestedProfileId = extension.modelProfileId;
  const ordinary = DRAWING_ORDINARY_ALIASES.has(model);
  const advanced = DRAWING_ADVANCED_SELECTIONS[model] ?? null;

  if (ordinary) {
    if (operation !== "images.generations") invalid("Drawing intent does not support this operation", "model");
    if (!UUID.test(drawingProfileId ?? "")) throw new PlatformError("compute_unavailable", "Drawing profile is not configured", { status: 503 });
    if (requestedProfileId !== null && requestedProfileId !== drawingProfileId) {
      if (!advancedAuthorized) {
        throw new PlatformError("model_profile_selection_forbidden", "Advanced Drawing model selection requires model inventory permission", {
          status: 403,
          details: { param: "x_teamaibox.model_profile_id" },
        });
      }
      invalid("The ordinary Drawing intent is pinned to the protected main-box profile", "x_teamaibox.model_profile_id");
    }
    return Object.freeze({
      ...extension,
      modelProfileId: drawingProfileId,
      drawingRouteAuthorization: Object.freeze({
        schema: "teamaibox.drawing-route-authorization.v2",
        policy_version: "protected-main-default.v1",
        selection_class: "ordinary-protected",
        model_alias: model,
        operation,
        model_profile_id: drawingProfileId,
      }),
    });
  }

  if (advanced) {
    if (!advancedAuthorized) {
      throw new PlatformError("model_profile_selection_forbidden", "Advanced Drawing model selection requires model inventory permission", {
        status: 403,
        details: { param: "x_teamaibox.model_profile_id" },
      });
    }
    if (operation !== advanced.operation || requestedProfileId !== advanced.profileId) {
      invalid("Drawing intent and model profile selection do not match", "x_teamaibox.model_profile_id");
    }
    return Object.freeze({
      ...extension,
      drawingRouteAuthorization: Object.freeze({
        schema: "teamaibox.drawing-route-authorization.v2",
        policy_version: "protected-main-default.v1",
        selection_class: "advanced-explicit",
        model_alias: model,
        operation,
        model_profile_id: advanced.profileId,
      }),
    });
  }

  if (requestedProfileId !== null) {
    if (!advancedAuthorized) {
      throw new PlatformError("model_profile_selection_forbidden", "Explicit Drawing model selection requires model inventory permission", {
        status: 403,
        details: { param: "x_teamaibox.model_profile_id" },
      });
    }
    invalid("Explicit Drawing profiles require a supported advanced intent", "model");
  }
  return extension;
}

function validateMessages(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1024) {
    invalid("messages must be a non-empty array", "messages");
  }
  const roles = new Set(["developer", "system", "user", "assistant", "tool"]);
  for (const [index, message] of value.entries()) {
    if (!record(message) || !roles.has(message.role)
      || !(typeof message.content === "string" || Array.isArray(message.content) || message.content === null)) {
      invalid("Chat message is invalid", `messages.${index}`);
    }
  }
}

function validateJsonSchemaFormat(value, param, { chat = false } = {}) {
  if (!record(value) || typeof value.type !== "string") {
    invalid(`${param} must be an object with a type`, param);
  }
  const allowed = chat ? new Set(["text", "json_object", "json_schema"]) : new Set(["text", "json_schema"]);
  if (!allowed.has(value.type)) invalid(`${param}.type is invalid`, `${param}.type`);
  if (value.type !== "json_schema") return;
  const declaration = chat ? value.json_schema : value;
  if (!record(declaration)
      || typeof declaration.name !== "string"
      || !/^[A-Za-z0-9_-]{1,64}$/.test(declaration.name)
      || !record(declaration.schema)
      || (declaration.strict !== undefined && typeof declaration.strict !== "boolean")) {
    invalid(`${param} JSON schema declaration is invalid`, param);
  }
}

function validateChat(body) {
  safeModel(body.model);
  validateMessages(body.messages);
  safeBoolean(body.stream, false, "stream");
  if (body.response_format !== undefined) {
    validateJsonSchemaFormat(body.response_format, "response_format", { chat: true });
  }
}

function validateResponse(body) {
  safeModel(body.model);
  if (!(typeof body.input === "string" || Array.isArray(body.input))) {
    invalid("input must be text or an input-item array", "input");
  }
  safeBoolean(body.stream, false, "stream");
  safeBoolean(body.background, false, "background");
  if (body.text !== undefined) {
    if (!record(body.text)) invalid("text must be an object", "text");
    if (body.text.format !== undefined) validateJsonSchemaFormat(body.text.format, "text.format");
  }
}

function validateEmbedding(body) {
  rejectUnknown(body, new Set(["model", "input", "encoding_format", "dimensions", "user", "x_teamaibox"]));
  safeModel(body.model);
  const valid = typeof body.input === "string"
    || (Array.isArray(body.input) && body.input.length > 0
      && body.input.every((item) => typeof item === "string" || Array.isArray(item)));
  if (!valid) invalid("Embedding input is invalid", "input");
  if (body.stream !== undefined) invalid("Embeddings do not support stream", "stream");
  if (body.encoding_format !== undefined && !new Set(["float", "base64"]).has(body.encoding_format)) {
    invalid("Embedding encoding format is invalid", "encoding_format");
  }
  if (body.dimensions !== undefined && (!Number.isSafeInteger(body.dimensions) || body.dimensions < 1 || body.dimensions > 65_536)) {
    invalid("Embedding dimensions are invalid", "dimensions");
  }
  if (body.user !== undefined && (typeof body.user !== "string" || body.user.length < 1 || body.user.length > 256 || /[\r\n\0]/.test(body.user))) {
    invalid("Embedding user is invalid", "user");
  }
}

function validateImage(body) {
  safeModel(body.model, { required: false });
  if (typeof body.prompt !== "string" || body.prompt.length < 1) {
    invalid("Image prompt is invalid", "prompt");
  }
  if (body.n !== undefined && (!Number.isInteger(body.n) || body.n < 1 || body.n > 10)) {
    invalid("Image count is invalid", "n");
  }
  if (body.size !== undefined && !new Set(["auto", "512x512", "768x768", "1024x1024", "1024x768", "768x1024", "1536x1024", "1024x1536"]).has(body.size)) {
    invalid("Image size is invalid", "size");
  }
  const drawing = body.x_teamaibox?.extensions?.drawing;
  if (drawing === undefined) return;
  if (!record(drawing)) invalid("Drawing extensions must be an object", "x_teamaibox.extensions.drawing");
  rejectUnknown(drawing, new Set(["preset_key", "seed", "steps", "guidance_scale", "negative_prompt", "output_format"]));
  if (drawing.preset_key !== undefined && (typeof drawing.preset_key !== "string" || !/^[a-z][a-z0-9_.-]{2,127}$/.test(drawing.preset_key))) invalid("Drawing preset is invalid", "x_teamaibox.extensions.drawing.preset_key");
  if (drawing.seed !== undefined && (!Number.isSafeInteger(drawing.seed) || drawing.seed < 0 || drawing.seed > 4_294_967_295)) invalid("Drawing seed is invalid", "x_teamaibox.extensions.drawing.seed");
  if (drawing.steps !== undefined && (!Number.isSafeInteger(drawing.steps) || drawing.steps < 1 || drawing.steps > 200)) invalid("Drawing steps are invalid", "x_teamaibox.extensions.drawing.steps");
  if (drawing.guidance_scale !== undefined && (!Number.isFinite(drawing.guidance_scale) || drawing.guidance_scale < 0 || drawing.guidance_scale > 50)) invalid("Drawing guidance scale is invalid", "x_teamaibox.extensions.drawing.guidance_scale");
  if (drawing.negative_prompt !== undefined && typeof drawing.negative_prompt !== "string") invalid("Negative prompt is invalid", "x_teamaibox.extensions.drawing.negative_prompt");
  if (drawing.output_format !== undefined && !new Set(["png", "jpeg", "webp"]).has(drawing.output_format)) invalid("Drawing output format is invalid", "x_teamaibox.extensions.drawing.output_format");
}

function protectedDrawingRequest(body, extension) {
  if (extension.drawingRouteAuthorization?.selection_class !== "ordinary-protected") return body;
  const drawing = body.x_teamaibox?.extensions?.drawing ?? {};
  if (body.n !== undefined && body.n !== 1) invalid("The main-box drawing profile supports one image", "n");
  if (body.size !== undefined && !new Set(["auto", "512x512"]).has(body.size)) {
    invalid("The main-box drawing profile supports 512x512", "size");
  }
  const fixed = { steps: 4, guidance_scale: 1, output_format: "png", negative_prompt: "" };
  for (const [field, value] of Object.entries(fixed)) {
    if (drawing[field] !== undefined && drawing[field] !== value) {
      invalid(`The main-box drawing profile requires ${field}=${value}`, `x_teamaibox.extensions.drawing.${field}`);
    }
  }
  return { ...body, n: 1, size: "512x512" };
}

const STANDARD_OPERATIONS = Object.freeze({
  "/v1/chat/completions": Object.freeze({
    operation: "chat.completions",
    capabilityKey: "chat",
    validate: validateChat,
    stream: true,
  }),
  "/v1/responses": Object.freeze({
    operation: "responses",
    capabilityKey: "text-transform",
    validate: validateResponse,
    stream: true,
  }),
  "/v1/embeddings": Object.freeze({
    operation: "embeddings",
    capabilityKey: "embedding",
    validate: validateEmbedding,
    stream: false,
  }),
  "/v1/images/generations": Object.freeze({
    operation: "images.generations",
    capabilityKey: "image-generation",
    validate: validateImage,
    stream: false,
  }),
});

export const computeApiClaims = Object.freeze([
  { id: "openai.chat-completions.create", family: "openai", protocol: "http", method: "POST", pathTemplate: "/v1/chat/completions", operation: "chat.completions" },
  { id: "openai.responses.create", family: "openai", protocol: "http", method: "POST", pathTemplate: "/v1/responses", operation: "responses" },
  { id: "openai.responses.retrieve", family: "openai", protocol: "http", method: "GET", pathTemplate: "/v1/responses/{response_id}", operation: "responses.retrieve" },
  { id: "openai.responses.cancel", family: "openai", protocol: "http", method: "POST", pathTemplate: "/v1/responses/{response_id}/cancel", operation: "responses.cancel" },
  { id: "openai.embeddings.create", family: "openai", protocol: "http", method: "POST", pathTemplate: "/v1/embeddings", operation: "embeddings" },
  { id: "openai.images.generate", family: "openai", protocol: "http", method: "POST", pathTemplate: "/v1/images/generations", operation: "images.generations" },
  { id: "extension.images.edit", family: "extension", protocol: "http", method: "POST", pathTemplate: "/api/v1/ai/images/edits", operation: "images.edits" },
  { id: "extension.ocr.submit", family: "extension", protocol: "http", method: "POST", pathTemplate: "/api/v1/ai/ocr", operation: "ocr" },
  { id: "extension.asr.submit", family: "extension", protocol: "http", method: "POST", pathTemplate: "/api/v1/ai/transcriptions", operation: "transcriptions" },
  { id: "extension.translations.submit", family: "extension", protocol: "http", method: "POST", pathTemplate: "/api/v1/ai/translations", operation: "translations" },
  { id: "extension.jobs.retrieve", family: "extension", protocol: "http", method: "GET", pathTemplate: "/api/v1/jobs/{job_id}", operation: "jobs.retrieve" },
  { id: "extension.jobs.cancel", family: "extension", protocol: "http", method: "POST", pathTemplate: "/api/v1/jobs/{job_id}/cancel", operation: "jobs.cancel" },
  { id: "extension.realtime.admit", family: "extension", protocol: "http", method: "POST", pathTemplate: "/api/v1/realtime/sessions", operation: "realtime.admit" },
  { id: "extension.realtime.stream", family: "extension", protocol: "websocket", method: "GET", pathTemplate: "/api/v1/realtime/sessions/{session_id}/stream", operation: "realtime.stream" },
].map((claim) => Object.freeze(claim)));

const FIXED_HTTP_CLAIMS = new Set(computeApiClaims
  .filter((claim) => claim.protocol === "http" && !claim.pathTemplate.includes("{"))
  .map((claim) => `${claim.method} ${claim.pathTemplate}`));

function requireReference(value, param) {
  if (!record(value) || typeof value.reference_id !== "string" || !UUID.test(value.reference_id)) {
    invalid("A valid scoped object reference identifier is required", param);
  }
  rejectUnknown(value, new Set(["reference_id"]));
  return { referenceId: value.reference_id };
}

function validateOcr(body) {
  rejectUnknown(body, new Set(["model", "input", "output_format", "language_hints", "x_teamaibox"]));
  const input = requireReference(body.input, "input");
  const outputFormat = body.output_format ?? "json";
  if (!["text", "json", "markdown", "hocr"].includes(outputFormat)) {
    invalid("OCR output format is invalid", "output_format");
  }
  const languageHints = body.language_hints ?? [];
  if (!Array.isArray(languageHints) || languageHints.length > 32) {
    invalid("OCR language hints are invalid", "language_hints");
  }
  languageHints.forEach((language, index) => safeLanguage(language, `language_hints.${index}`, { required: true }));
  return {
    model: safeModel(body.model, { required: false }),
    input,
    outputFormat,
    languageHints,
  };
}

function validateAsr(body) {
  rejectUnknown(body, new Set([
    "model", "input", "language", "output_format", "timestamp_granularities",
    "speaker_information", "x_teamaibox",
  ]));
  const input = requireReference(body.input, "input");
  const outputFormat = body.output_format ?? "json";
  if (!new Set(["json", "text", "srt", "vtt"]).has(outputFormat)) {
    invalid("Transcription output format is invalid", "output_format");
  }
  const timestampGranularities = body.timestamp_granularities ?? ["segment"];
  if (!Array.isArray(timestampGranularities) || timestampGranularities.length < 1
    || timestampGranularities.length > 2 || new Set(timestampGranularities).size !== timestampGranularities.length
    || timestampGranularities.some((item) => !new Set(["segment", "word"]).has(item))) {
    invalid("Timestamp granularities are invalid", "timestamp_granularities");
  }
  return {
    model: safeModel(body.model, { required: false }),
    input,
    language: safeLanguage(body.language, "language"),
    outputFormat,
    timestampGranularities,
    speakerInformation: safeBoolean(body.speaker_information, false, "speaker_information"),
  };
}

function validateTranslation(body) {
  rejectUnknown(body, new Set([
    "model", "input_text", "input_reference", "source_language", "target_language",
    "input_kind", "input_representation", "output_format", "preserve_layout", "include_intermediates", "x_teamaibox",
  ]));
  const hasText = typeof body.input_text === "string" && body.input_text.length > 0;
  const hasReference = body.input_reference !== undefined;
  if (hasText === hasReference) {
    invalid("Exactly one translation input is required", "input_text");
  }
  const outputFormat = body.output_format ?? "text";
  if (!["text", "json", "markdown", "srt", "vtt"].includes(outputFormat)) {
    invalid("Translation output format is invalid", "output_format");
  }
  const inputKind = body.input_kind ?? (hasText ? "text" : null);
  if (!new Set(["text", "image", "document", "audio", "video"]).has(inputKind)) {
    invalid("Translation input kind is required for object references", "input_kind");
  }
  if ((hasText && inputKind !== "text") || (hasReference && inputKind === "text")) {
    invalid("Translation input kind does not match the submitted input", "input_kind");
  }
  const inputRepresentation = body.input_representation ?? "source";
  if (!new Set(["source", "ocr-result", "asr-result"]).has(inputRepresentation)
      || (inputRepresentation === "ocr-result" && !new Set(["image", "document"]).has(inputKind))
      || (inputRepresentation === "asr-result" && !new Set(["audio", "video"]).has(inputKind))
      || (inputKind === "text" && inputRepresentation !== "source")) {
    invalid("Translation input representation does not match the input kind", "input_representation");
  }
  if (["srt", "vtt"].includes(outputFormat) && !new Set(["audio", "video"]).has(inputKind)) {
    invalid("Subtitle output requires audio or video input", "output_format");
  }
  const stages = inputKind === "text" || inputRepresentation === "ocr-result"
    ? [{ stageId: "translate", capabilityKey: "translation", dependsOn: [] }]
    : inputRepresentation === "asr-result"
      ? [
          { stageId: "translate", capabilityKey: "translation", dependsOn: [] },
          { stageId: "compose-subtitles", capabilityKey: "subtitle-compose", dependsOn: ["translate"] },
        ]
      : new Set(["image", "document"]).has(inputKind)
      ? [
          { stageId: "extract-text", capabilityKey: "ocr", dependsOn: [] },
          { stageId: "translate", capabilityKey: "translation", dependsOn: ["extract-text"] },
        ]
      : [
          { stageId: "transcribe", capabilityKey: "asr", dependsOn: [] },
          { stageId: "translate", capabilityKey: "translation", dependsOn: ["transcribe"] },
          { stageId: "compose-subtitles", capabilityKey: "subtitle-compose", dependsOn: ["translate"] },
        ];
  return {
    model: safeModel(body.model, { required: false }),
    inputKind,
    inputRepresentation,
    input: hasText
      ? { text: body.input_text }
      : requireReference(body.input_reference, "input_reference"),
    sourceLanguage: safeLanguage(body.source_language, "source_language"),
    targetLanguage: safeLanguage(body.target_language, "target_language", { required: true }),
    outputFormat,
    preserveLayout: safeBoolean(body.preserve_layout, true, "preserve_layout"),
    includeIntermediates: safeBoolean(body.include_intermediates, true, "include_intermediates"),
    workflow: Object.freeze(stages.map((stage) => Object.freeze({
      stageId: stage.stageId,
      capabilityKey: stage.capabilityKey,
      dependsOn: Object.freeze(stage.dependsOn),
    }))),
  };
}

function validateImageEdit(body) {
  rejectUnknown(body, new Set([
    "model", "prompt", "input", "mask", "n", "size", "preset_key", "seed",
    "strength", "steps", "guidance_scale", "negative_prompt", "output_format", "x_teamaibox",
  ]));
  if (typeof body.prompt !== "string" || body.prompt.length < 1) invalid("Image edit prompt is invalid", "prompt");
  const input = requireReference(body.input, "input");
  const mask = body.mask === undefined ? null : requireReference(body.mask, "mask");
  const count = body.n ?? 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > 4) invalid("Image count is invalid", "n");
  const size = body.size ?? "1024x1024";
  if (!new Set(["512x512", "768x768", "1024x1024", "1024x768", "768x1024"]).has(size)) invalid("Image size is invalid", "size");
  const presetKey = body.preset_key ?? "drawing.balanced.v1";
  if (typeof presetKey !== "string" || !/^[a-z][a-z0-9_.-]{2,127}$/.test(presetKey)) invalid("Drawing preset is invalid", "preset_key");
  const seed = body.seed ?? null;
  if (seed !== null && (!Number.isSafeInteger(seed) || seed < 0 || seed > 4_294_967_295)) invalid("Drawing seed is invalid", "seed");
  const strength = body.strength ?? 0.65;
  if (!Number.isFinite(strength) || strength <= 0 || strength > 1) invalid("Image edit strength is invalid", "strength");
  const steps = body.steps ?? null;
  if (steps !== null && (!Number.isSafeInteger(steps) || steps < 1 || steps > 200)) invalid("Drawing steps are invalid", "steps");
  const guidanceScale = body.guidance_scale ?? null;
  if (guidanceScale !== null && (!Number.isFinite(guidanceScale) || guidanceScale < 0 || guidanceScale > 50)) invalid("Drawing guidance scale is invalid", "guidance_scale");
  const negativePrompt = body.negative_prompt ?? null;
  if (negativePrompt !== null && typeof negativePrompt !== "string") invalid("Negative prompt is invalid", "negative_prompt");
  const outputFormat = body.output_format ?? "png";
  if (!new Set(["png", "jpeg", "webp"]).has(outputFormat)) invalid("Drawing output format is invalid", "output_format");
  return {
    model: safeModel(body.model, { required: false }), prompt: body.prompt,
    input, mask, count, size, presetKey, seed, strength, steps, guidanceScale,
    negativePrompt, outputFormat,
  };
}

function validateRealtime(body) {
  rejectUnknown(body, new Set(["capability", "model", "expires_in_seconds", "input", "output"]));
  const capabilities = new Set(["asr", "translation", "codec", "webrtc-gateway"]);
  if (!capabilities.has(body.capability)) invalid("Realtime capability is invalid", "capability");
  const expiresInSeconds = body.expires_in_seconds ?? 300;
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 30 || expiresInSeconds > 3600) {
    invalid("Realtime session lifetime is invalid", "expires_in_seconds");
  }
  if (body.input !== undefined && !record(body.input)) invalid("Realtime input is invalid", "input");
  if (body.output !== undefined && !record(body.output)) invalid("Realtime output is invalid", "output");
  return {
    capability: body.capability,
    model: safeModel(body.model, { required: false }),
    expiresInSeconds,
    input: structuredClone(body.input ?? {}),
    output: structuredClone(body.output ?? {}),
  };
}

function requireJob(value) {
  if (!record(value) || typeof value.jobId !== "string" || !UUID.test(value.jobId)
    || !JOB_STATES.has(value.status)
    || (value.route !== undefined && !JOB_ROUTES.has(value.route))
    || typeof value.createdAt !== "string"
    || Number.isNaN(new Date(value.createdAt).getTime())) {
    throw new PlatformError("compute_backend_invalid", "Compute backend returned an invalid job", { status: 502 });
  }
  return value;
}

function requireRealtimeReservation(value, sessionId) {
  const resources = value?.resources;
  const resourceKeys = [
    "cpu_millis", "unified_memory_bytes", "accelerator_units", "codec_sessions",
    "storage_bytes", "network_bits_per_second", "codec_encode_sessions", "codec_decode_sessions",
  ];
  if (!record(value)
      || value.reservation_id !== sessionId
      || value.reservation_kind !== "realtime"
      || value.priority_class !== "latency"
      || value.protected_from_batch !== true
      || !Number.isInteger(value.latency_budget_milliseconds)
      || value.latency_budget_milliseconds < 10
      || value.latency_budget_milliseconds > 10_000
      || !record(resources)
      || resourceKeys.some((key) => !Number.isSafeInteger(resources[key]) || resources[key] < 0)) {
    throw new PlatformError("compute_backend_invalid", "Realtime reservation is invalid", { status: 502 });
  }
  return value;
}

function jobExtension(job) {
  return Object.freeze({
    job_id: job.jobId,
    state: job.status,
    route: job.route ?? "unassigned",
    profile_id: job.profileId ?? null,
    attempt_id: job.attemptId ?? null,
  });
}

function acceptedJob(job, operation) {
  const resultSchemas = {
    "images.generations": "teamaibox.ai.image-result.v1",
    "images.edits": "teamaibox.ai.image-result.v1",
    ocr: "teamaibox.ai.ocr-result.v1",
    transcriptions: "teamaibox.ai.asr-result.v1",
    translations: "teamaibox.ai.translation-result.v1",
  };
  return Object.freeze({
    job_id: job.jobId,
    object: "teamaibox.job",
    operation,
    result_schema: resultSchemas[operation] ?? null,
    status: job.status,
    progress: Object.freeze({
      value: Number.isFinite(job.progress?.value)
        ? Math.min(1, Math.max(0, job.progress.value))
        : job.status === "succeeded" ? 1 : 0,
      revision: Number.isSafeInteger(job.progress?.revision) ? job.progress.revision : 1,
      sequence: Number.isSafeInteger(job.progress?.sequence) ? job.progress.sequence : 0,
      message_key: typeof job.progress?.messageKey === "string" ? job.progress.messageKey : `tasks.state.${job.status}`,
    }),
    waiting_reason: typeof job.waitingReason === "string" ? job.waitingReason : null,
    error: record(job.error) ? Object.freeze({
      code: typeof job.error.code === "string" ? job.error.code : "compute_failed",
      message: typeof job.error.message === "string" ? job.error.message : "Compute job did not complete",
      retryable: job.error.retryable === true,
      guidance_key: typeof job.error.guidanceKey === "string" ? job.error.guidanceKey : null,
      retry_action: typeof job.error.retryAction === "string" ? job.error.retryAction : null,
    }) : null,
    created_at: Math.floor(new Date(job.createdAt).getTime() / 1000),
    result: record(job.result) ? Object.freeze(structuredClone(job.result)) : null,
    x_teamaibox: jobExtension(job),
    links: Object.freeze({ self: `/api/v1/jobs/${job.jobId}`, cancel: `/api/v1/jobs/${job.jobId}/cancel` }),
  });
}

function acceptedOpenAi(job, definition, body) {
  const created = Math.floor(new Date(job.createdAt).getTime() / 1000);
  if (definition.operation === "responses") {
    return Object.freeze({
      id: job.responseId ?? `resp_${job.jobId.replaceAll("-", "")}`,
      object: "response",
      created_at: created,
      status: job.status,
      background: true,
      model: body.model,
      output: Object.freeze([]),
      error: null,
      x_teamaibox: jobExtension(job),
    });
  }
  return Object.freeze({
    id: `job_${job.jobId.replaceAll("-", "")}`,
    object: "teamaibox.job",
    created,
    model: body.model ?? null,
    status: job.status,
    x_teamaibox: jobExtension(job),
  });
}

function submission({ context, requestId, definition, body, extension, idempotencyKey }) {
  return Object.freeze({
    ownerIdentityId: context.identityId,
    capabilityKey: definition.capabilityKey,
    operation: definition.operation,
    requestedModel: body.model ?? null,
    requestedModelProfileId: extension.modelProfileId,
    dataClass: extension.dataClass,
    priority: extension.priority,
    deadlineAt: extension.deadlineAt,
    idempotencyKey,
    correlationId: requestId,
    deferDispatch: extension.background || (definition.operation === "responses" && body.background === true),
    request: requestWithExtensions(body, extension),
  });
}

function responseIdFromPath(pathname) {
  const match = /^\/v1\/responses\/([A-Za-z0-9][A-Za-z0-9_-]{7,127})(\/cancel)?$/.exec(pathname);
  return match ? { responseId: match[1], cancel: Boolean(match[2]) } : null;
}

function jobIdFromPath(pathname) {
  const match = /^\/api\/v1\/jobs\/([0-9a-f-]{36})(\/cancel)?$/i.exec(pathname);
  if (!match || !UUID.test(match[1])) return null;
  return { jobId: match[1], cancel: Boolean(match[2]) };
}

function realtimeSessionIdFromPath(pathname) {
  const match = /^\/api\/v1\/realtime\/sessions\/([0-9a-f-]{36})\/(?:stream|events)$/i.exec(pathname);
  return match && UUID.test(match[1]) ? match[1] : null;
}

export function matchesComputeRealtimeRoute(pathname) {
  return realtimeSessionIdFromPath(pathname) !== null;
}

export function matchesComputeHttpRoute(method, pathname) {
  if (FIXED_HTTP_CLAIMS.has(`${method} ${pathname}`)) return true;
  const response = responseIdFromPath(pathname);
  if (response && ((method === "GET" && !response.cancel) || (method === "POST" && response.cancel))) return true;
  const job = jobIdFromPath(pathname);
  return Boolean(job && ((method === "GET" && !job.cancel) || (method === "POST" && job.cancel)));
}

export class ComputeHttpApi {
  #backend;
  #drawingProfileId;

  constructor({ backend, drawingProfileId = DRAWING_MAIN_PROTECTED_PROFILE_ID }) {
    const required = [
      "invoke", "stream", "submit", "getJob", "cancelJob", "admitRealtime",
      "connectRealtime", "heartbeatRealtime", "disconnectRealtime",
    ];
    if (!backend || required.some((method) => typeof backend[method] !== "function")) {
      throw new TypeError("compute HTTP backend is incomplete");
    }
    this.#backend = backend;
    this.#drawingProfileId = drawingProfileId;
  }

  async connectRealtimeSession({ pathname, context, connectionId, now }) {
    const sessionId = realtimeSessionIdFromPath(pathname);
    if (!sessionId) throw new PlatformError("not_found", "Realtime endpoint was not found", { status: 404 });
    return this.#backend.connectRealtime({
      ownerIdentityId: context.identityId, sessionId, connectionId, now,
    });
  }

  async heartbeatRealtimeSession({ sessionId, context, connectionId, now }) {
    if (!UUID.test(sessionId)) throw new PlatformError("not_found", "Realtime session was not found", { status: 404 });
    return this.#backend.heartbeatRealtime({
      ownerIdentityId: context.identityId, sessionId, connectionId, now,
    });
  }

  async disconnectRealtimeSession({ sessionId, context, connectionId, reason, now }) {
    if (!UUID.test(sessionId)) throw new PlatformError("not_found", "Realtime session was not found", { status: 404 });
    return this.#backend.disconnectRealtime({
      ownerIdentityId: context.identityId, sessionId, connectionId, reason, now,
    });
  }

  matches(method, pathname) {
    return matchesComputeHttpRoute(method, pathname);
  }

  async handle({ method, pathname, body = null, context, headers = {}, requestId = randomUUID() }) {
    if (!context?.identityId) throw new PlatformError("invalid_session", "Authentication is required", { status: 401 });
    const definition = STANDARD_OPERATIONS[pathname];
    if (method === "POST" && definition) {
      if (!record(body)) invalid("Request body must be an object");
      if (context.modelAliases !== undefined) {
        if (!Array.isArray(context.modelAliases)
            || context.modelAliases.some((value) => typeof value !== "string" || !MODEL.test(value))) {
          throw new PlatformError("credential_context_invalid", "Credential model scope is invalid", { status: 500 });
        }
        if (!context.modelAliases.includes(body.model)) {
          throw new PlatformError("access_denied", "Credential cannot invoke the requested model", { status: 403 });
        }
      }
      definition.validate(body);
      const extension = drawingProfileSelection({
        drawingProfileId: this.#drawingProfileId,
        context,
        operation: definition.operation,
        model: body.model,
        extension: safeExtension(body.x_teamaibox),
      });
      if (definition.operation === "images.generations") body = protectedDrawingRequest(body, extension);
      const idempotencyKey = idempotencyFrom(headers, extension);
      const work = submission({ context, requestId, definition, body, extension, idempotencyKey });
      const background = extension.background
        || (definition.operation === "responses" && body.background === true);
      if (background) {
        const job = requireJob(await this.#backend.submit(work));
        return { kind: "json", status: 202, body: acceptedOpenAi(job, definition, body) };
      }
      if (body.stream === true) {
        if (!definition.stream) invalid("This operation does not support stream", "stream");
        const events = await this.#backend.stream(work);
        if (!events?.[Symbol.asyncIterator]) {
          throw new PlatformError("compute_backend_invalid", "Compute stream is unavailable", { status: 502 });
        }
        return {
          kind: "sse",
          status: 200,
          events,
          doneMarker: definition.operation === "chat.completions" ? "[DONE]" : null,
        };
      }
      const result = await this.#backend.invoke(work);
      const job = requireJob(result?.job);
      if (!record(result?.body)) {
        throw new PlatformError("compute_backend_invalid", "Compute backend returned an invalid result", { status: 502 });
      }
      return {
        kind: "json",
        status: 200,
        body: Object.freeze({ ...result.body, x_teamaibox: jobExtension(job) }),
      };
    }

    if (method === "POST" && pathname === "/api/v1/ai/ocr") {
      if (!record(body)) invalid("Request body must be an object");
      const extension = safeExtension(body.x_teamaibox);
      const normalized = validateOcr(body);
      const job = requireJob(await this.#backend.submit({
        ownerIdentityId: context.identityId,
        capabilityKey: "ocr",
        operation: "ocr",
        requestedModel: normalized.model,
        requestedModelProfileId: extension.modelProfileId,
        dataClass: extension.dataClass,
        priority: extension.priority,
        deadlineAt: extension.deadlineAt,
        idempotencyKey: idempotencyFrom(headers, extension),
        correlationId: requestId,
        deferDispatch: extension.background,
        request: normalized,
      }));
      return { kind: "json", status: 202, body: acceptedJob(job, "ocr") };
    }

    if (method === "POST" && pathname === "/api/v1/ai/transcriptions") {
      if (!record(body)) invalid("Request body must be an object");
      const extension = safeExtension(body.x_teamaibox);
      const normalized = validateAsr(body);
      const job = requireJob(await this.#backend.submit({
        ownerIdentityId: context.identityId,
        capabilityKey: "asr",
        operation: "transcriptions",
        requestedModel: normalized.model,
        requestedModelProfileId: extension.modelProfileId,
        dataClass: extension.dataClass,
        priority: extension.priority,
        deadlineAt: extension.deadlineAt,
        idempotencyKey: idempotencyFrom(headers, extension),
        correlationId: requestId,
        deferDispatch: extension.background,
        request: normalized,
      }));
      return { kind: "json", status: 202, body: acceptedJob(job, "transcriptions") };
    }

    if (method === "POST" && pathname === "/api/v1/ai/translations") {
      if (!record(body)) invalid("Request body must be an object");
      const extension = safeExtension(body.x_teamaibox);
      const normalized = validateTranslation(body);
      const job = requireJob(await this.#backend.submit({
        ownerIdentityId: context.identityId,
        capabilityKey: "translation",
        operation: "translations",
        requestedModel: normalized.model,
        requestedModelProfileId: extension.modelProfileId,
        dataClass: extension.dataClass,
        priority: extension.priority,
        deadlineAt: extension.deadlineAt,
        idempotencyKey: idempotencyFrom(headers, extension),
        correlationId: requestId,
        deferDispatch: extension.background,
        request: normalized,
      }));
      return { kind: "json", status: 202, body: acceptedJob(job, "translations") };
    }

    if (method === "POST" && pathname === "/api/v1/ai/images/edits") {
      if (!record(body)) invalid("Request body must be an object");
      const extension = drawingProfileSelection({
        drawingProfileId: this.#drawingProfileId,
        context,
        operation: "images.edits",
        model: body.model,
        extension: safeExtension(body.x_teamaibox),
      });
      const normalized = validateImageEdit(body);
      const job = requireJob(await this.#backend.submit({
        ownerIdentityId: context.identityId,
        capabilityKey: "image-generation",
        operation: "images.edits",
        requestedModel: normalized.model,
        requestedModelProfileId: extension.modelProfileId,
        dataClass: extension.dataClass,
        priority: extension.priority,
        deadlineAt: extension.deadlineAt,
        idempotencyKey: idempotencyFrom(headers, extension),
        correlationId: requestId,
        deferDispatch: extension.background,
        request: {
          ...normalized,
          extensions: extension.extensions,
          ...(extension.drawingRouteAuthorization ? {
            x_teamaibox: {
              routing_authorization: structuredClone(extension.drawingRouteAuthorization),
            },
          } : {}),
        },
      }));
      return { kind: "json", status: 202, body: acceptedJob(job, "images.edits") };
    }

    if (method === "POST" && pathname === "/api/v1/realtime/sessions") {
      if (!record(body)) invalid("Request body must be an object");
      const normalized = validateRealtime(body);
      const session = await this.#backend.admitRealtime({
        ownerIdentityId: context.identityId,
        correlationId: requestId,
        ...normalized,
      });
      if (!record(session) || typeof session.sessionId !== "string" || !UUID.test(session.sessionId)
        || typeof session.expiresAt !== "string" || Number.isNaN(new Date(session.expiresAt).getTime())
        || !record(session.reservation)) {
        throw new PlatformError("compute_backend_invalid", "Realtime admission returned an invalid session", { status: 502 });
      }
      const reservation = requireRealtimeReservation(session.reservation, session.sessionId);
      return {
        kind: "json",
        status: 201,
        body: Object.freeze({
          session_id: session.sessionId,
          object: "teamaibox.realtime.session",
          protocol_version: 1,
          capability: normalized.capability,
          model: normalized.model,
          status: "admitted",
          expires_at: session.expiresAt,
          websocket_url: `/api/v1/realtime/sessions/${session.sessionId}/stream`,
          reservation,
        }),
      };
    }

    const responsePath = responseIdFromPath(pathname);
    if (responsePath && RESPONSE_ID.test(responsePath.responseId)) {
      const job = responsePath.cancel
        ? await this.#backend.cancelJob({ ownerIdentityId: context.identityId, responseId: responsePath.responseId })
        : await this.#backend.getJob({ ownerIdentityId: context.identityId, responseId: responsePath.responseId });
      const normalized = requireJob(job);
      return {
        kind: "json",
        status: 200,
        body: Object.freeze({
          id: responsePath.responseId,
          object: "response",
          created_at: Math.floor(new Date(normalized.createdAt).getTime() / 1000),
          status: normalized.status,
          background: true,
          model: normalized.model ?? null,
          output: Object.freeze(normalized.output ?? []),
          error: normalized.error ?? null,
          x_teamaibox: jobExtension(normalized),
        }),
      };
    }

    const jobPath = jobIdFromPath(pathname);
    if (jobPath) {
      const job = jobPath.cancel
        ? await this.#backend.cancelJob({ ownerIdentityId: context.identityId, jobId: jobPath.jobId })
        : await this.#backend.getJob({ ownerIdentityId: context.identityId, jobId: jobPath.jobId });
      const normalized = requireJob(job);
      return {
        kind: "json",
        status: jobPath.cancel ? 202 : 200,
        body: acceptedJob(normalized, normalized.operation ?? "unknown"),
      };
    }

    throw new PlatformError("not_found", "Endpoint was not found", { status: 404 });
  }
}

export const selectedOpenAiOperations = Object.freeze(Object.fromEntries(
  computeApiClaims
    .filter((claim) => claim.family === "openai" && claim.method === "POST" && STANDARD_OPERATIONS[claim.pathTemplate])
    .map((claim) => [claim.pathTemplate, claim.operation]),
));
