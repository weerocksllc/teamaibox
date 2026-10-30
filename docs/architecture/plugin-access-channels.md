# Plugin access channels

OpenSpec task: `6.5`

ApplicationPlugin and ComputePlugin access are deliberately different trust
paths. They share the signed manifest and sandbox lifecycle, but they do not
share credentials or registry mutation authority.

## ApplicationPlugin user delegation

An authenticated Web launch requests exact `(scope, resource)` grants. The
broker verifies that every scope is declared by the active manifest, supported
by Plugin API v1, and currently held by the local user for the exact appliance
or team resource. It issues an opaque 256-bit token for 15–300 seconds, bound
to the user session, plugin audience, current version, current plugin
generation, and exact grants.

Only a peppered HMAC-SHA256 token digest is stored. The raw credential is shown
once and stays in the plugin's in-memory request flow; it is not projected as a
permanent container credential, put in a URL, browser storage, log, audit event,
or object reference. Every use rechecks expiry/revocation, live session and
account state, active plugin state/version/generation, exact grant coverage,
and current user authorization. Logout/account changes, explicit revocation,
plugin disable/uninstall, and version cutover therefore fail closed immediately.

## ComputePlugin scheduler registration

A ComputePlugin reports a minimal claim—scheduler-assigned certified model
profile ID plus sorted logical operations—over the fenced worker-control
channel. It cannot call a public registry endpoint. The protected scheduler
authority verifier supplies the worker, node, lease, fencing token, and worker
generation; values asserted by the plugin are not accepted.

The registry checks the enabled ComputePlugin version/generation, healthy
ready/busy worker, exact plugin/worker/profile ownership, current lease/fence,
certified model profile, and operation subset. PostgreSQL repeats these facts
inside the registration insert. Registrations expire within five minutes,
are immutable within a worker generation, can be retired by the scheduler, and
are filtered again on every scheduler read. They never carry user identity,
user tokens, provider endpoints, physical GPU identity, or a routing decision.

## Persistent state

Migration 18 adds:

- `plugins.delegated_user_tokens`, with hash-only token identity, exact JSON
  grants, session/plugin composite foreign keys, bounded lifetime, and
  revocation state;
- `plugins.compute_capability_registrations`, with composite plugin-version,
  plugin-worker, node-worker, and capability-profile keys plus lease/fence,
  generation, expiry, state, and registration digest.

The public Plugin SDK exposes delegated grant/client types and the minimal
ComputePlugin claim type. It intentionally exposes no direct capability
registration method.
