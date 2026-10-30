# ComputePlugin worker lifecycle

OpenSpec task: `5.7`

## Ownership boundaries

The scheduler owns lifecycle policy and the durable worker projection. It never
opens the Docker socket and never accepts an arbitrary worker endpoint from a
plugin. Only the Node Agent can create, inspect, or remove the digest-pinned
container. Once started, the ComputePlugin implements the bidirectional v1
worker-control envelope over its assigned private control channel.

Two fences have distinct purposes:

- the worker control lease/fence remains attached to the container for Node
  Agent health and stop operations, allowing warm reuse across jobs;
- each execute/cancel request carries the admitted job lease/fence, preventing
  a delayed attempt from becoming valid merely because the worker stayed warm.

All response messages must match protocol version, worker ID, correlation ID,
`extensions.replyTo`, lease ID, fencing token, and the operation's allowed
response types. A stale generation, fence, worker identity, or reply ID fails
closed.

## State transitions

```text
stopped -> starting -> preparing -> ready -> busy
   ^                                |       |
   |                                +-------+  terminal execute
   |                                |
   +-- stopping <- draining <-------+          unload / idle timeout

starting/preparing/busy -> failed -> starting  bounded restart backoff
                              |
                              +-> circuit_open -> failed  half-open expiry
```

- `ensureReady` shares one in-flight cold start per worker. It checks Node Agent
  health, sends `worker.prepare.request`, verifies the exact profile and
  generation, then marks the worker warm.
- A healthy `ready` or `busy` instance can be reused without start/prepare. The
  execute path still enforces `maxConcurrentAttempts` before dispatch.
- `worker.execute.request` holds attempt ownership until a fenced terminal
  `succeeded`, `failed`, or `cancelled` response arrives.
- Cancellation is cooperative. An `accepted` response leaves the attempt busy
  and cancellation-pending; only `cancelled` or `not_found` releases ownership.
  The lifecycle manager does not silently convert a cancellation timeout into
  an unsafe replay or force-kill.
- Explicit unload and the idle sweep reject active attempts, send
  `worker.unload.request`, and only then ask Node Agent to stop the container.
- A crash clears worker attempt ownership and returns affected attempt IDs to
  the scheduler's accepted/unaccepted reconciliation boundary.

## Crash policy

Crash timestamps use a rolling policy window. Before the threshold, restart
delay doubles from the configured base to a bounded maximum. At the threshold,
the worker enters `circuit_open` until the configured expiry, emits an alertable
event, and cannot be selected for another cold start. The circuit sweep moves
an expired circuit to half-open (`failed` with retry allowed); successful
prepare clears the crash window, while another crash can reopen the circuit.

## Persistence and events

Migration 13 creates `compute.worker_instances`. `PostgresWorkerRepository`
serializes every mutation with `SELECT ... FOR UPDATE` and persists the full
state needed after scheduler restart. Database checks constrain state/active
attempt consistency, generation/health, concurrency, crash count, and circuit
expiry. The migration is reversible and its SQL smoke walks stopped, preparing,
ready, busy, rejected-invalid-circuit, and valid-circuit states.

The manager requires a durable event sink. Dispatch is not sent when the
`worker.execution_started` event cannot be persisted, and the reserved worker
slot is released. Events contain only correlation and resource identifiers,
timing, stable reason codes, affected attempt IDs, and bounded artifact
references. User content, raw results, credentials, object grants, and private
worker addresses remain outside event payloads.
