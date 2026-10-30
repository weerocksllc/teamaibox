# Local identity boundary

The appliance authenticates only local users and service accounts. It has no
LDAP, Active Directory, OIDC, enterprise SSO, external group synchronization,
or hidden emergency administrator account.

The first-run transaction creates exactly one owner and shows eight random
one-time recovery codes. Recovery resets that existing owner, increments the
password version, revokes every session, replaces all recovery codes, and
requires a proof from a separately controlled local recovery surface. It never
creates a bypass identity and is not exposed as an ordinary remote sign-in API.
The production recovery surface issues a short-lived browser challenge. A local
operator with appliance Docker authority signs that exact challenge inside the
Platform API container using a protected HMAC key; the proof is single-use,
expires after five minutes, is rate-limited by network, and becomes invalid on
service restart. Neither the protected key nor a reusable proof is returned by
an HTTP endpoint.

Passwords use NFC normalization, a minimum of 15 Unicode code points, no
composition rules, a local/common/context blocklist, and versioned Argon2id
parameters. Session and CSRF values are returned only at creation; persistence
stores SHA-256 token hashes, bounded idle/absolute expiry, password version,
revocation state, and hashed network/user-agent binding metadata.

`PostgresIdentityRepository` is the durable appliance adapter. It serializes the
one-time owner bootstrap, account/network lockout counters, final-owner checks,
recovery generation changes, and session revocation in PostgreSQL transactions.
`MemoryIdentityRepository` remains available for isolated tests and the explicit
development preview only.

Developer and service API credentials are a separate boundary. The API returns
their random secret once and persists only a keyed HMAC-SHA-256 digest resolved
with a protected service-scoped pepper. Developer issuance is self-only,
non-administrative, and capped at 90 days. Service issuance requires credential
administration, remains inside active service-account grants, and is capped at
365 days. Authentication rechecks current identity, role/grant, scope, expiry,
and revocation state before every operation.

Locale and theme are ordinary per-account preferences, not authorization
claims. Only an active local user can update their own `preferred_locale` or
`preferred_theme`; supported values are constrained in both the service and
PostgreSQL schema and each change is audited.
