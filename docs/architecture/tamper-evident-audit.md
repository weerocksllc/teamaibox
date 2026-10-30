# Tamper-evident audit chain

Team AI Box records security-relevant platform activity as a single, durable,
append-only evidence chain. The chain is an operational security control; it is
not a second application log and never stores user prompts, document contents,
object paths, provider URLs, credentials, tokens, or command output.

## Event boundary

Every accepted event is normalized into a closed versioned envelope containing
an event UUID, timestamp, actor identity/kind, action, one of the thirteen
required domains, outcome, bounded resource reference, correlation ID, and an
allowlisted metadata projection. The domains are identity, data, plugin, model,
provider, routing, Agent confirmation, source, security, key, update,
and administrator operations.

The service computes `SHA-256(canonical({event, previousEventHash}))`. It signs
that hash with an HMAC-SHA256 checkpoint and appends the event only if the
repository head still matches. The PostgreSQL repository serializes writers
with an advisory transaction lock; the memory repository uses compare-and-set.
Both paths therefore converge concurrent writers without chain forks.

PostgreSQL rows at schema version 1 are protected by a trigger that rejects
updates and deletes. Identity accounts are disabled rather than deleted so the
actor reference and audit history remain intact.

## Signing keys and rotation

Persistent deployments must inject a protected signer or signing key. Startup
fails closed when PostgreSQL is configured without one. The platform does not
persist an automatically generated signing key beside the audit rows.

Key rotation uses a retained keyring. A checkpoint captures the active key ID
and signature atomically; activation cannot produce a signature labelled with a
different key. Old verification keys remain available for the full audit
retention period and remain in protected persistent storage. Historical archive-domain events remain readable for chain verification.
Owned in-memory key buffers are zeroed when the platform server closes.

## Verification and access

Only identities with `audit:view` may list events or verify the chain. The API
is read-only, cursor-bounded, and can filter by domain. Verification scans in
ascending sequence order, recomputes every hash, verifies each checkpoint with
its recorded key ID, and compares the final record with the repository head.
It reports the first failed sequence and a bounded reason code without exposing
the canonical private payload.

The administrator UI shows event identity, domain, outcome, actor/resource
references, sequence, hashes, and the chain verdict. It intentionally does not
render metadata. Both the API contract and UI are covered by privacy, tamper,
concurrency, permission, locale, theme, and browser interaction tests.
