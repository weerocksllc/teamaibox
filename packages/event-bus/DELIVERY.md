# Durable delivery contract

PostgreSQL is the fact store. A business transaction calls
platform.enqueue_outbox before commit. Publishers claim ready rows with
FOR UPDATE SKIP LOCKED, publish the versioned envelope to JetStream with
Nats-Msg-Id equal to eventId, and record stream/sequence only when the matching
claim token still owns the row. Expired claims are retryable.

JetStream is configured for explicit acknowledgements and may redeliver.
Consumers must begin a database transaction and call platform.claim_inbox with
their stable durable consumer name, event ID/type, and SHA-256 of the received
payload:

- acquired: apply the business mutation and complete the inbox receipt in the
  same database transaction, commit, then acknowledge JetStream;
- processed: acknowledge without applying the mutation again;
- busy: do not acknowledge; allow redelivery after the active claim resolves;
- payload_mismatch: do not process or acknowledge; quarantine and alert because
  an event ID was reused with different bytes or type.

If a handler fails predictably it may mark the receipt failed in the same
transaction. A later delivery can acquire a failed/expired receipt. Process
crashes before commit leave both business mutation and receipt uncommitted; a
crash after commit but before acknowledgement produces a harmless processed
redelivery.

Outbox publication and inbox processing are at-least-once transports with
idempotent database effects. They do not claim exactly-once behavior for
external providers, Agent tools, or other side effects without a separate
idempotency/reconciliation contract.

