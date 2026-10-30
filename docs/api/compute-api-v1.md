# Compute API v1

The Compute API is the stable, authenticated boundary used by browser
applications, plugins, Agent sandboxes, developer clients, and service
accounts. Clients choose a logical model alias or immutable model-profile ID;
they cannot choose a node, worker, container, provider, or endpoint.

## Authentication

All routes require HTTPS at the public Web boundary and the `ai:invoke`
permission.

- Browser applications use the appliance session cookie. State-changing calls
  also require the configured HTTPS `Origin` and `X-CSRF-Token`.
- Authorized developer and service clients use `Authorization: Bearer <secret>`.
  Credential scope, current account state, expiry, and revocation are checked
  on every call. Bearer values are never returned or logged.

## Selected OpenAI-compatible routes

| Method | Route | Operation | Response behavior |
| --- | --- | --- | --- |
| `POST` | `/v1/chat/completions` | Chat Completions | JSON or standard data-only SSE ending in `[DONE]` |
| `POST` | `/v1/responses` | Responses | JSON, typed SSE events, or a background response |
| `GET` | `/v1/responses/{response_id}` | Retrieve background response | Current durable job projection |
| `POST` | `/v1/responses/{response_id}/cancel` | Cancel background response | Updated durable job projection |
| `POST` | `/v1/embeddings` | Embeddings | Standard list response |
| `POST` | `/v1/images/generations` | Image generation | Standard image response |

Only these operations are claimed in v1. In particular, the OpenAI audio
transcription route requires multipart file semantics; it is not claimed until
the gateway can stream the upload into encrypted object storage before durable
submission. Long appliance speech work will not be represented by a
non-standard JSON body under `/v1/audio/transcriptions`.

OpenAI response fields keep their standard meaning. Appliance metadata is
additive under `x_teamaibox`:

```json
{
  "job_id": "11111111-1111-4111-8111-111111111111",
  "state": "running",
  "route": "local",
  "profile_id": "22222222-2222-4222-8222-222222222222",
  "attempt_id": "33333333-3333-4333-8333-333333333333"
}
```

Requests may include `x_teamaibox` with `background`, `data_class`, `priority`,
`deadline_at`, `idempotency_key`, or `model_profile_id`. `Idempotency-Key` is
also accepted as an HTTP header. If both locations are present, they must
match. Future vendor data belongs under `x_teamaibox.extensions`; unknown
top-level extension fields fail closed.

Chat Completions accepts `response_format` with `text`, `json_object`, or a
named `json_schema`. Responses accepts `text.format` with `text` or a named
`json_schema`. Malformed schema declarations fail before queue admission; the
validated declaration is preserved byte-for-byte in the protected request
payload delivered to the selected worker/provider.

`POST /v1/responses` uses the standard `background: true` behavior for a
pollable response. Other selected operations can request the appliance's
general background-job projection with `x_teamaibox.background: true`.

## Platform extension routes

Platform-only operations use `/api/v1`; their schemas are cataloged under
`packages/contracts/http`.

### OCR

`POST /api/v1/ai/ocr` accepts an authorized, immutable object reference rather
than raw bytes or an object-store credential:

```json
{
  "input": {"reference_id": "11111111-1111-4111-8111-111111111111"},
  "output_format": "markdown",
  "language_hints": ["zh-CN", "en"],
  "x_teamaibox": {"priority": 60, "data_class": "confidential"}
}
```

It returns `202` and a `teamaibox.job` resource. The terminal job's typed OCR
result (`teamaibox.ai.ocr-result.v1`) preserves page/block geometry and
artifacts and is persisted by the durable-job layer.

### Translation

`POST /api/v1/ai/translations` accepts exactly one of `input_text` or an
authorized `input_reference`, plus `target_language`. It returns `202` and a
traceable job. Image and audio translation applications compose OCR or ASR
jobs explicitly so intermediate provenance is retained. Terminal output uses
`teamaibox.ai.translation-result.v1` with aligned segments and artifacts.

### Speech transcription

`POST /api/v1/ai/transcriptions` accepts an authorized media reference plus
language, segment/word timestamp, speaker-information, and output-format
options. It returns one `202` parent job. When the selected certified profile
permits long-audio sharding, the scheduler creates overlapping internal shard
jobs while preserving that public job identity.

Shard calls use the cataloged `compute/asr-shard-request.v1` contract and
attempt-scoped object references. Encrypted shard transcript objects conform to
`compute/asr-shard-transcript.v1`. The final
`teamaibox.ai.asr-result.v1` remains ordered by source time and can include
segment-level shard, timestamp, result-artifact, and speaker provenance plus
the complete immutable shard-plan digest. No storage credential or compute
address appears in either contract.

### Jobs

`GET /api/v1/jobs/{job_id}` retrieves an owned job and
`POST /api/v1/jobs/{job_id}/cancel` requests cancellation. Returning `202` is
the acceptance boundary: a client may retry only with the same idempotency key
and request facts. The digest includes model/profile, priority, data class,
deadline, and request body. Queue persistence, progress, cooperative
cancellation, terminal results, and retry classification are implemented by
the durable job service behind this API rather than in the HTTP adapter.
The job projection always contains `result`; it is `null` until a terminal
typed result exists. OCR and translation results carry only scoped
`ArtifactRef` values. Storage credentials, signed URLs, worker addresses, and
provider endpoints are never result fields.

### Realtime sessions

`POST /api/v1/realtime/sessions` accepts ASR, translation, codec or WebRTC gateway
requests with a bounded lifetime. The authenticated owner receives a relative
WebSocket URL only for an enabled healthy runtime. CPU, memory, codecs and
network are not pre-booked. A legacy `reservation` field is runtime metadata,
not a capacity entitlement. Owner checks, one connection per session, expiry,
heartbeat and node-generation fencing remain. Real startup/allocation failures
are reported without fabricating success or terminating unrelated workloads.
