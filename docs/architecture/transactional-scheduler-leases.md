# Transactional scheduler leases

Transactional leases bind a scheduling decision to one durable, fenced attempt.
A successful score alone never authorizes dispatch. A lease establishes operation
ownership, not a reservation of shared CPU, memory, codec, storage or network
capacity.

The former additive resource-booking model is retired. Current runtime policy is
described in [runtime health and exclusive maintenance](runtime-health-and-exclusive-maintenance.md)
and [unified-memory observation and OOM recovery](unified-memory-pressure-and-oom-safeguards.md).
Do not restore cross-application admission checks by summing configured maxima or
legacy reservation fields. Actual runtime limits, observed pressure, allocation
failures and recovery safeguards remain in force.

## Atomic acquisition

The PostgreSQL repository performs these operations in one transaction:

1. Resolve the idempotent acquisition key.
2. Lock the durable job row and reject terminal/cancelled work.
3. Lock the target node row and re-check `ready` state and generation.
4. Lock and re-check the exact certified model profile and capability.
5. Close due lease sets on the node.
6. Reject another active lease set for the same job.
7. Enforce explicit exclusive-maintenance intent and conflicting operation
   boundaries; ordinary shared work does not book capacity in advance.
8. Increment the per-node fencing sequence.
9. Insert the attempt and master lease set, plus an exclusive-operation row when
   required by the maintenance intent.
10. Move the job to `admitted` and append its durable state event.

Scheduler acquisition uses this repository to serialize ownership and exclusive
maintenance decisions. The node row lock prevents conflicting lifecycle changes;
it does not implement an additive capacity ledger or guarantee physical headroom.

## Lease model

`compute.lease_sets` is the master ownership record for one attempt. It binds:

- acquisition key, lease token, node ID/generation, and monotonically
  increasing fencing token;
- job, attempt, immutable certified profile, and retained compatibility metadata;
- acquired, heartbeat, expiry, dispatch, acceptance, release, and reconciliation
  timestamps/state.

The legacy `reservation` field remains for identity and wire compatibility; its
name is not permission to reserve physical resources. The old additive CPU,
unified-memory, accelerator, codec, storage and network model is historical, not
the current admission policy. `compute.leases` retains the exclusive-operation
record where needed. A partial unique index permits only one active lease set
per job.

## Heartbeat and fencing

A heartbeat succeeds only when all of these facts still match:

- unguessable lease token;
- exact numeric fencing token;
- active, unexpired lease;
- ready node with the same generation.

It extends the master and associated lease expiries together. A released, expired,
revoked, or older-fence holder cannot renew or dispatch. Re-acquisition after
release/expiry receives a strictly higher per-node fence, allowing the Node
Agent to reject delayed commands from an older scheduler/worker process.

## Duplicate-dispatch boundary

`claimDispatch` atomically changes `pending → claimed`, binds a globally unique
dispatch ID, marks the attempt dispatched, and moves the job to preparing.
Repeating the same ID returns the existing claim; a different ID is a conflict.
`acknowledgeDispatch` changes `claimed → accepted` and records
`accepted_no_output` on the attempt. This boundary is intentionally before
the [worker execution and result lifecycle](compute-plugin-worker-lifecycle.md).

## Reconciliation

Reconciliation locks active lease/attempt/job/node facts with `SKIP LOCKED` and:

- releases leases whose job is already terminal;
- expires TTL-overdue leases;
- revokes leases whose node is offline or whose generation changed;
- detects active attempts that no longer have an active lease.

Unaccepted attempts become `lost` and their jobs return to `queued` with a
stable wait reason. Accepted attempts become `incomplete` with
`manual_reconcile`; they are never blindly replayed. Reconciliation is safe to
repeat, and healthy leases record the last pass without changing ownership.

The lease does not start Docker or touch devices. The authenticated Node Agent
must validate the node generation and fencing token again before acting.
