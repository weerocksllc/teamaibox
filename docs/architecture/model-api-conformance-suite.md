# Model API conformance suite

The model API claim boundary is deliberately smaller than “anything an
OpenAI-compatible server might accept.” Team AI Box certifies only the twelve
operations listed in
`architecture/validation/compute-api-conformance.v1.json`. The runtime exports
the same immutable claim list, and the contract suite requires exact equality.
This prevents a route from becoming a compatibility promise merely because a
backend happens to respond to it.

## Certification coverage

Every claim has a representative executable path and seven mandatory
dimensions:

1. endpoint and response shape;
2. SSE/WebSocket shape or an explicit non-streaming result;
3. explicit cancellation semantics or a declared non-applicable state;
4. OpenAI or platform error envelope at the real HTTP transport;
5. structured-output validation and preservation where applicable;
6. inline media, standard content items, or scoped ArtifactRef handling;
7. durable request fingerprints, deterministic projections, idempotent
   cancellation, or an explicit realtime exemption.

The suite exercises all six non-realtime creation families through the real
durable job service. Request bodies are envelope-encrypted before queue
insertion. Repeating the same owner, operation, key, and canonical facts returns
the same job identity; changing priority or any other fingerprinted fact with
that key fails with `idempotency_conflict`.

Chat streaming remains data-only SSE and ends in `[DONE]`. Responses streaming
uses typed SSE event names and no synthetic done marker. Realtime admission is
the sole queue exemption and becomes usable only through an owner-scoped
WebSocket whose disconnect releases the reservation.

## Artifacts and cancellation

OCR and translation submission accept immutable scoped object references, not
bytes, storage credentials, or signed URLs. A retrieved extension job includes
its typed terminal `result`; any produced media is represented by scoped
ArtifactRef values. Standard image generation may return its standard inline
base64 payload.

`POST /v1/responses/{response_id}/cancel` returns the standard response
projection. `POST /api/v1/jobs/{job_id}/cancel` returns `202` because it records
a cooperative cancellation request; repeated calls retain one job identity and
terminal state. A client disconnecting from SSE does not authorize blind
replay or cancellation of the durable job.

## Release gate

The suite is run by `pnpm test:node` locally and by the ARM64 `node-contracts`
suite on the development DGX Spark. A missing claim, dimension, representative
route, error envelope, or behavioral assertion blocks conformance and therefore
blocks the model validation Certification stage.
