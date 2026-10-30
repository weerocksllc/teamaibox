# Scheduler

Expands logical capabilities into eligible model profiles/providers, applies
resource and data-policy filters, scores candidates, enforces fairness and
realtime/exclusive policy, acquires fenced leases, and dispatches attempts.

It never starts containers directly and never treats event delivery as the
authoritative job state.

## Routing decision core

`src/routing-engine.mjs` accepts an already expanded list of target/profile
pairs. It first applies fail-closed hard filters and only scores candidates
that satisfy every filter. The decision contains complete rejection reasons
and per-component score contributions; a stable profile/target identifier
tie-breaker makes replay deterministic.

Hard filters cover:

- target health, operation, requested profile, and `certified` state;
- target/profile architecture compatibility;
- profile, target, and external-processing data policy;
- accelerator type/precision/compute capability;
- storage class and network class/latency;
- user/team/capability quota and concurrency gates.

Local CPU, memory, codecs and bandwidth are shared by normal OS scheduling.
Configured guest/model maxima are not booked against other workloads. Actual
health, OOM and allocation failures remain observable. External providers keep
their explicit concurrency contract; no private hardware metrics are invented.

Eligible targets receive separate `loadCost`, `locality`,
`capacityHeadroom`, `queueFairness`, `network`, and `routingWeight` score
components. Default weights are exported as `DEFAULT_SCORING_WEIGHTS` and can
be replaced only by known, non-negative values.

`src/fair-share.mjs` calculates dominant hierarchical usage across user,
team, and capability scopes. `rankQueuedJobs` preserves administrator
priority, adds a bounded wait-time boost, then applies fair share and FIFO.
Quota- or concurrency-blocked jobs are returned separately with stable task
center reason codes.

The module owns policy decisions only. Transactional resource leasing is the
next boundary, and Docker/device control remains exclusive to the Node Agent.

## Transactional fenced leases

`LeaseManager` validates complete six-dimensional reservations and bounded
lease TTLs. `PostgresLeaseRepository` locks the durable job and target node,
re-checks node generation and exact certified profile, expires due leases,
aggregates active reservations, and creates the attempt plus lease set in one
transaction. A per-node counter issues monotonically increasing fencing tokens.

An acquisition key makes scheduler retries idempotent. A partial unique index
allows additive CPU, unified-memory, accelerator, codec, storage, and network
leases while retaining single-owner constraints for worker, realtime, and
exclusive resources. A job can have only one active lease set.

Dispatch uses a second exactly-once boundary:

1. `claimDispatch` binds a globally unique dispatch ID while the lease, target
   health, node generation, and fencing token remain valid.
2. Replaying the same dispatch ID is idempotent; a different ID is rejected.
3. `acknowledgeDispatch` records the attempt acceptance boundary. If the lease
   is later lost, unaccepted work is requeued, while accepted work becomes
   `incomplete` for manual reconciliation instead of blind replay.

Heartbeats extend both the lease set and its resource rows. Expiry, release,
node generation changes, terminal-job cleanup, and orphan attempts are handled
by `reconcileLeaseSets`. Stale tokens cannot renew, dispatch, acknowledge, or
release a newer allocation.

## ComputePlugin worker lifecycle

`WorkerLifecycleManager` turns a fenced lease decision into the versioned
worker-control protocol without receiving Docker or device access. It asks the
Node Agent to start, inspect, or stop the container and talks to the worker only
through `prepare`, `execute`, cooperative `cancel`, and `unload` messages.

Cold workers pass `stopped -> starting -> preparing -> ready`; an already
healthy worker is reused without another start or model load. Execution reserves
the declared concurrency before dispatch and returns the worker to warm `ready`
only after a fenced terminal response. Idle policy unloads the model before the
Node Agent removes the container.

Lifecycle state is persisted by `PostgresWorkerRepository` under row lock,
including generation, health, active attempts, reservations, control fence,
load/idle times, crash history, next retry, and circuit expiry. The in-memory
repository implements the same interface for deterministic tests. Repeated
crashes use bounded exponential backoff, then open a per-worker circuit and
surface affected attempt IDs for job reconciliation.

Every control response must match protocol version, worker, correlation,
request reply ID, lease, fence, and allowed response type. Lifecycle events
contain IDs, state, timing, reason codes, and artifact references only; model
inputs, output content, credentials, and worker addresses are not copied into
events. Production wiring must use the durable outbox event sink.

## Maintenance and node exclusivity

There is no advance resource pool or fixed core-service floor. Authentication,
exact worker/run identity, operation fencing and explicit maintenance locks
remain. Only a deliberately node-exclusive operation drains its conflicts;
ordinary phones, computers and casting do not stop each other to obtain a slot.

## Local appliance identity and dispatch

The scheduler dispatches local work only to the appliance identified by
`PLATFORM_APPLIANCE_NODE_ID`. This stable UUID is installation configuration;
a service restart does not create a new device or recreate Android/Windows
data. The local Agent command endpoint is loopback-only and uses the installed
appliance certificate. An optional external OpenAI-compatible provider remains
a separate, explicit data-policy choice, not a second appliance.

`ProtectedNodeAgentClient` signs commands and verifies command, device,
generation, lease, and fencing identities. `PostgresAppliancePlacementRepository`
resolves the existing local placement for protected office transitions.
Readiness and exact runtime identity are checked before dispatch; unavailable services block
new work rather than causing guest deletion or data reset.

Local API and Agent processes share the appliance control network namespace in
`deploy/appliance/production.compose.yaml`. Public access remains through the
HTTPS browser API. There is no remote enrollment, SSH installer, device-group
scheduler, or distributed update workflow.

## Realtime sessions

Realtime sessions resolve an enabled healthy placement and preserve owner,
expiry, heartbeat, reconnection and node-generation checks. They do not acquire
CPU, RAM, codec or network quotas. The legacy wire field `reservation` describes
runtime configuration only and grants no pooled capacity. Closing a socket
closes that session, not another user's runtime. Casting serializes receiver
start/stop and forwards one browser media rendition to its authorized viewers.

## Unified-memory observation

`UnifiedMemoryGuard` observes fresh host memory/PSI, owned cgroups, runtime OOM
and inference-engine evidence. It reports warnings and real failures; it does
not deduct configured maxima, model-load estimates or fixed emergency margins
before starting work. No dedicated VRAM pool is invented on DGX Spark.
`MemoryPressureCoordinator` can fence a genuinely failed worker and unload idle
non-protected workers; ownership, protected residents and user data remain safe.
