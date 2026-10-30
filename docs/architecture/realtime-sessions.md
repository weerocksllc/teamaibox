# Realtime sessions

Realtime speech and media sessions do not enter the durable batch queue. The
API authenticates the owner, resolves a healthy compatible profile and records
the session with an exact node generation, connection deadline and expiry.
CPU, RAM, codec and bandwidth settings are not booked against shared totals.

Warm and lower-latency profiles can be preferred. A missing compatible healthy
runtime produces a specific service error, not a fabricated resource quota.
The returned WebSocket URL is relative and same-origin; physical endpoints and
internal tokens are not exposed.

Explicit maintenance still serializes conflicting operations. This protects
runtime identity and user data; it is not normal capacity admission. Ordinary
session creation never asks users to stop an idle guest to free an accounting
entry.

The authenticated owner must connect before the connection deadline. Only one
connection identity owns a session. Heartbeats verify the node generation but
do not extend absolute expiry. Disconnect closes only that session; retries
remain idempotent. Reconciliation closes abandoned, expired and stale-fence
sessions. Legacy wire field `reservation` describes the session configuration,
not an entitlement or capacity allocation.
