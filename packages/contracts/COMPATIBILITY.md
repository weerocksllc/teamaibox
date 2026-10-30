# Interface versioning and compatibility policy

Team AI Box versions the platform with SemVer and versions every independently
consumed interface family with an integer protocol major. A platform release
does not silently change a protocol major.

## Common rules

- Stable HTTP and OpenAI-style routes carry the major in `/api/v1` or `/v1`.
  Internal message subjects, envelopes, plugin manifests, compute-domain
  objects, Node Agent, worker, realtime, and object references carry `v1` or an
  explicit `protocolVersion`.
- Patch releases correct implementation defects without changing a contract.
  Minor releases may add optional request members, optional response members,
  new endpoints/events/capabilities, and explicitly extensible enum values.
- Clients must ignore unknown response members. Servers reject unknown request
  members unless the schema marks an extension map. Unknown events or plugin
  capabilities are ignored only when the envelope marks them optional.
- Removing or renaming a member, changing its meaning or type, adding a required
  request member, narrowing accepted input, weakening an existing response
  guarantee, changing ordering/idempotency, or reusing an identifier is
  breaking and requires a new major.
- Every request, stream, command, and retry preserves correlation and stable
  operation/job/message identity. Reconnect or retry does not imply safe replay
  after an acceptance boundary unless the contract explicitly says so.

## Family rules

- General HTTP uses `/api/v{major}` and the shared error envelope. Deprecated
  endpoints return `Deprecation`, `Sunset`, and `Link` headers.
- OpenAI-compatible endpoints retain `/v1` wire shapes. Platform-only data is
  placed in documented `x_teamaibox` extension objects or extension endpoints;
  it never alters the meaning of a standard OpenAI field.
- SSE and WebSocket sessions negotiate a supported major before application
  events. Envelopes carry session, event, sequence, correlation, and resume
  identity. Unknown required event types close with a version error.
- Node Agent and worker control protocols require an explicit handshake range,
  authenticated peer identity, command/message ID, lease identity and fencing
  where applicable, deadline, idempotency classification, and versioned result.
- Plugin manifests use `teamaibox.io/plugin/v1`; SDK compatibility is a declared
  range. A plugin is staged but not activated when required contracts or
  capabilities are unavailable.
- Object references are opaque, scoped, expiring, immutable-version references.
  New grants are additive; changing object identity, integrity, scope, expiry,
  or audience semantics is breaking.
- Compute-domain objects use `teamaibox.compute.v{major}`. Capability identity
  is independent from physical routing; published ModelProfiles are immutable;
  Job and Attempt identities are distinct; reservations carry no bearer token;
  and provider errors preserve the acceptance/replay boundary. Consumers use
  ArtifactRefs instead of object credentials or worker/container addresses.

## Deprecation

Stable public interfaces receive at least 180 days notice and remain available
for at least one subsequent minor platform release. Internal managed protocols
receive at least 90 days and require a proven rolling-upgrade overlap. Every
deprecation records announcement time, replacement, earliest sunset, affected
major, migration guidance, and contract-test evidence. Emergency removal is
limited to an actively exploitable security issue and requires a security
advisory plus an explicit compatibility exception record.

## Contract gates

The catalog validator checks family coverage, version placement, schema
metadata, deprecation policy, and file identity. The compatibility checker uses
direction-aware rules: a newer consumer must continue accepting old valid
inputs, while a newer producer must continue honoring old output guarantees.
Golden cross-version fixtures and live provider/worker/plugin conformance suites
will use the same catalog entries as implementation tasks are added.
