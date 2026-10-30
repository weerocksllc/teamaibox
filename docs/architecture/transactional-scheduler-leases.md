# Transactional scheduler leases

OpenSpec task 5.5 turns the pure target decision from task 5.4 into a durable,
fenced allocation. A successful score alone never authorizes dispatch.

## Atomic acquisition

The PostgreSQL repository performs these operations in one transaction:

1. Resolve the idempotent acquisition key.
2. Lock the durable job row and reject terminal/cancelled work.
3. Lock the target node row and re-check `ready` state and generation.
4. Lock and re-check the exact certified model profile and capability.
5. Close due lease sets on the node.
6. Reject another active lease set for the same job.
7. Sum every active reservation on the locked node and compare all six
   dimensions with its known capacity.
8. Increment the per-node fencing sequence.
9. Insert the attempt, master lease set, and per-resource evidence rows.
10. Move the job to `admitted` and append its durable state event.

All scheduler acquisition paths must use this repository. The node row lock is
the serialization boundary for additive capacity, so two schedulers cannot
both observe the same free memory and overcommit it.

## Lease model

`compute.lease_sets` is the master record for one attempt allocation. It binds:

- acquisition key, lease token, node ID/generation, and monotonically
  increasing fencing token;
- job, attempt, immutable certified profile, and the complete reservation;
- acquired, heartbeat, expiry, dispatch, acceptance, release, and reconciliation
  timestamps/state.

`compute.leases` retains resource-level evidence. CPU, unified memory,
accelerator, codec, storage, and network rows are additive. Worker, realtime,
and exclusive resources retain a unique active `(kind, key)` constraint. A
partial unique index permits only one active lease set per job.

## Heartbeat and fencing

A heartbeat succeeds only when all of these facts still match:

- unguessable lease token;
- exact numeric fencing token;
- active, unexpired lease;
- ready node with the same generation.

It extends the master and resource expiries together. A released, expired,
revoked, or older-fence holder cannot renew or dispatch. Re-acquisition after
release/expiry receives a strictly higher per-node fence, allowing the Node
Agent to reject delayed commands from an older scheduler/worker process.

## Duplicate-dispatch boundary

`claimDispatch` atomically changes `pending → claimed`, binds a globally unique
dispatch ID, marks the attempt dispatched, and moves the job to preparing.
Repeating the same ID returns the existing claim; a different ID is a conflict.
`acknowledgeDispatch` changes `claimed → accepted` and records
`accepted_no_output` on the attempt. This boundary is intentionally before
worker execution/result semantics, which task 5.7 will add.

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

The lease does not start Docker or touch devices. Task 5.6's authenticated Node
Agent must validate the node generation and fencing token again before acting.
