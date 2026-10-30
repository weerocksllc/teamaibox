# External provider object transfer

External OpenAI-compatible providers never receive an object-store endpoint,
bucket, namespace, object key, access key, session credential, or internal
signed-object token. A scheduled external attempt receives only an opaque HTTPS
content URL for each exact input and, when required, one opaque output URL.

## Grant boundary

- A grant is bound to one owner, queued job, attempt, external provider, direction,
  audience, operation set, media type, byte limit, and expiry.
- Input grants wrap an existing immutable object version and its SHA-256 digest.
  They allow only `HEAD`, `GET`, and bounded byte ranges.
- Output grants allow one `PUT` to a platform-generated destination. The request
  must declare `Content-Type` and `x-content-sha256`; size, type, and any expected
  digest are verified before the one-time transition from `active` to `consuming`.
- Expiry is the earlier of the attempt lease and 15 minutes. Attempt completion,
  cancellation, or dispatch rollback revokes the proxy grant and its underlying
  object reference.

The bearer value is 256 random bits. Only its SHA-256 digest is persisted. The
URL contains no object identity, and the proxy has no list, prefix, version,
delete, copy, or arbitrary-key route. HTTP access is accepted only through the
HTTPS edge. Successful reads are served by the protected object service, which
verifies the complete encrypted blob before returning full or ranged content.

## Output consistency

An invalid upload does not consume the grant. Once a valid upload wins the
atomic authorization transition, concurrent or repeated writes are rejected.
Storage failure moves the grant to `failed`; it is never reopened automatically.
If storage commit succeeds but grant finalization cannot be proven, the caller
receives `external_object_output_reconcile_required` and the attempt must be
reconciled rather than replayed blindly.

## Persistence invariants

Migration 45 adds `compute.external_object_grants`. Database triggers verify that
the owner, job, attempt, external provider, audience, underlying input reference,
and integrity digest agree. Ticket material and storage credentials have no
column. Terminal grants cannot return to an active state, and immutable scope
facts cannot be edited after issuance.
