# Contracts

Source schemas and generated types for versioned public and internal
interfaces: HTTP/OpenAI-style extensions, events, workers, Node Agent, plugins,
objects, realtime sessions, and structured errors.

Contracts contain no service implementation or infrastructure client.
`COMPATIBILITY.md` is the normative human-readable policy.
`interface-families.v1.json` and `catalog.v1.json` are its machine-checked
counterparts. Every stable interface must appear in the catalog, carry
contract metadata in its JSON Schema, and pass the compatibility checker before
an in-place release. Breaking changes require a new major protocol location.

The `compute.v1` family publishes the shared logical domain used by the API,
scheduler, Node Agent, workers, plugins, and provider adapters:

- `Capability` identifies a logical AI operation independently of a container
  or provider address.
- immutable `ModelProfile` pins source revision, license/provenance, engine and
  image digest, artifact digest, precision including NVFP4, API contracts,
  limits, compatibility, data policy, certification, and a unified-memory
  resource envelope. A material change creates a new profile identity.
- `Job` is the durable user-owned request; `Attempt` is one fenced execution on
  one managed node or external provider.
- `Reservation` carries resource quantities, lease identity, expiry, and
  fencing without exposing a bearer lease token. `WorkerInstance` describes a
  managed lifecycle identity without publishing a container ID/address.
- `ArtifactRef` points to an immutable object version through reference
  identity and integrity metadata, never a signed token or storage credential.
- `ProviderError` normalizes acceptance, retry, and replay safety without
  persisting a raw upstream response.

The public Compute API uses the same logical domain. Cataloged OpenAI request
and job extensions add scheduling facts without changing standard field
meaning. Cataloged HTTP v1 schemas cover OCR and translation submissions, job
resources, and realtime admission/session resources; all media inputs use
scoped object references rather than storage credentials or physical worker
addresses. See `docs/api/compute-api-v1.md` for the route contract.
