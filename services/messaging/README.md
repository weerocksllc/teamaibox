# Messaging

Durable team conversations/messages, realtime delivery, presence projections,
and notification events used by the official browser messaging plugin and
authorized third-party applications.

Message truth is persisted; the event bus is used for delivery and projection,
not as the only copy.

The v1 domain service supports canonical direct conversations, managed group
membership, ordered idempotent messages, history, monotonic queued/delivered/
read receipts, notifications, shared-conversation presence, permission-scoped
search, and user or service-account authors. Application and bot authors must
hold the same message permission and active conversation membership as a user.

Attachments enter through a short-lived object reference, but that reference
is never retained in message history. The attachment verifier resolves it to
an authorized immutable object ID/version, filename, media type, size, and
SHA-256. PostgreSQL stores only those durable facts; clients request a fresh
scoped object reference when they later download the attachment.

`PostgresMessagingRepository` commits the message, attachment facts, recipient
receipts, notifications, ordered realtime event, and redacted outbox record in
one database transaction. Search always joins active membership before matching
message content or attachment filenames. Migration 30 defines the durable
schema and its SQL smoke covers state constraints and cascading conversation
cleanup.

`MessagingRealtimeGateway` authenticates through the service, replays durable
events after a caller cursor, projects presence with expiring connection IDs,
and advances delivery state only after a connection accepts an event. A broken
connection is closed without blocking other authorized recipients. The broker
passes only a persisted event ID under the internal outbox authority; it cannot
forge recipients or message data.

Stable browser/application contracts cover conversations, message submission,
message history records, and realtime events. They intentionally expose
ephemeral attachment reference IDs only on submission and immutable object
version facts on durable responses.
