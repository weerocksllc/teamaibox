# External provider attempt lifecycle

An external OpenAI-compatible call remains one durable Team AI Box job, but
each provider submission is a separate ordered attempt. The scheduler records
the provider acceptance boundary before it trusts output or makes a retry
decision.

## Acceptance states

1. `not_accepted`: no provider acknowledgement has been durably observed.
2. `accepted_no_output`: a provider request identifier is durable, but no output
   bytes have been observed.
3. `output_observed`: at least one ordered output digest/size fact is durable.
4. `side_effect_uncertain`: the transport cannot prove whether a non-idempotent
   effect occurred.

Only `not_accepted` permits normal policy failover after a retryable transport
failure. An administrator may declare a provider-key idempotency contract that
permits a same-provider retry after acceptance, or a side-effect-free contract
that permits cross-provider replay before any output. These are explicit
exceptions. They never make a partial stream blindly replayable.

After output or uncertainty, the attempt enters provider status reconciliation
when the registered execution contract supplies a status path and request
identifier. Without that contract the job is `incomplete` with
`manual_reconcile`; it is not submitted again automatically.

## Provider execution contract

Provider registration stores and validates:

- idempotency mode and exact header;
- replay boundary (`prohibited`, `same_provider`, or `any_provider`);
- side-effect class;
- a status path containing exactly one `{request_id}` placeholder;
- cancellation mode, method, and exact request path template.

The safe default provides none of these optional behaviors and prohibits replay
after acceptance. A non-idempotent provider cannot declare an accepted replay.
Cross-provider replay is limited to work declared to have no side effect.

## Streams, cancellation, and reconciliation

Streaming callbacks first persist `accepted`, then append output sequence,
byte-count, and SHA-256 facts. Chunk contents are never written to the attempt
history. Missing acceptance before output fails closed.

Cancellation is mapped from provider evidence. A confirmed cancellation becomes
terminal. Unsupported, pending, failed, or ambiguous cancellation after
acceptance becomes `reconcile_required`; the platform does not report a false
cancelled state. Reconciliation may adopt only a result that already exists as
an integrity-verified protected object in the owner's encrypted namespace.

Migration 46 adds the provider execution contract, one durable external
dispatch row per attempt, and append-only attempt events. Database triggers bind
the attempt to the job owner and external provider, enforce monotonic acceptance
and output facts, protect terminal states, and verify any completed object hash
and namespace.
