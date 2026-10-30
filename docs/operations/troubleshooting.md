# Troubleshooting

## Triage safely

Start with the administrator Dashboard and Diagnostics views. Record time,
release digest, affected identity/tenant, correlation/job/attempt ID, service
and node generation, model profile, route class, and bounded error code. Check
telemetry freshness before interpreting values: stale or absent CPU, unified
memory, storage, queue, worker, or provider facts are a monitoring
fault, not zero usage.

Never request passwords, recovery codes, bearer/delegation tokens, provider
keys, TLS/audit keys, signed object URLs, prompts, message/file content,
model source credentials, or raw environment dumps. Export only the redacted,
size-bounded diagnostics bundle and verify its digest before transfer.

## Service and sign-in failures

- If the Web origin is unreachable, check container health and the containerized
  TLS ingress; do not publish raw API ports or install a host Web server.
- If the browser reports HTTP/certificate/Origin/CSRF failure, stop using that
  origin. Verify certificate, canonical HTTPS origin, time, proxy headers,
  `__Host-` cookie rules, and duplicate CSRF cookies.
- If all sessions vanished after restart, determine whether a development
  in-memory API was used. This is expected for the integration preview and is
  a release blocker, not a user-account repair procedure.
- On database, event-bus, object, or audit failure, fence mutations and compute
  admission. Restart only through the controlled process workflow and verify
  durable state/idempotency/audit before reopening.

## Application iframe stays blank during browser automation

A server HTTP 200 does not prove that the browser committed and rendered the
application document. Check the iframe's presentation state and whether its
scripts actually start loading before treating this as an appliance failure.

If the symptom occurs while a browser automation debugger is attached, compare
the same navigation using native browser controls with only that debugging
session detached. Chrome's debugging infobar identifies the attached client.
If cancelling that session resumes the existing iframe without a page reload,
record the automation interference separately from a product regression.
Do not disable browser security, clear account data, restart applications, or
add automatic reload loops to compensate for an attached debugger.

The Web shell bounds the presentation wait and provides an explicit Retry
action. A late valid presentation event can recover the existing frame without
reloading it. This guard is not evidence that the original cause is repaired.

## Queues, workers, and models

- `queued`: inspect service health, capacity, exclusive lease, model load/wake,
  deadline, per-user/capability quota, worker/node health, and routing policy.
- `capability_unavailable`: no healthy certified matching route exists. Check
  profile lifecycle, environment drift, data class, plugin generation, and
  provider health.
- repeated or ambiguous external attempts: do not blindly retry. Use operation
  and idempotency facts, provider attempt state, and output reconciliation.
- unified-memory pressure/OOM: stop new admission, preserve service health, drain
  or unload the responsible profile, and validate the measured resource
  envelope. Do not lower the protected floor.
- local execution service unavailable: check the Device page, installed local
  identity, service configuration, time, generation, inventory and heartbeat.
  Preserve the installed identity; recreating it is not a repair for stale
  leases or results.
- realtime refused: inspect reservation resources and expiry. Realtime is not
  converted into an unreserved batch or direct worker call.

## Casting receiver disappears after pairing

If a receiver was discoverable, paired, and then disappeared when media
started, inspect the exact session's terminal state and output failure code
before asking the sender to reconnect. A healthy control listener is not
proof that the media publisher can start.

The browser publisher needs the separate `gstreamer1.0-nice` package in
addition to `gstreamer1.0-plugins-bad` and the LiveKit sink. Missing `nicesrc`
or `nicesink` prevents `webrtcbin` from creating its transport pads. Image
build checks and fresh readiness must check ICE, DTLS, SCTP and RTP elements,
not just that the sink is registered. Repair only the affected media image;
do not disable TLS, log publisher credentials, or restart unrelated guests.
After a terminal session, use the normal UI to start a fresh receiver. An old
background tab's waiting state does not prove its advertisement is still live.

## Storage, sources, and plugins

- Object digest/version/reference failure: quarantine staging bytes, preserve
  immutable metadata, and retry through the authorized upload/reference flow.
  Never expose a backing path or credential.
- Source failure: check declared policy, signed metadata, trust, architecture,
  offline media identity, cache freshness, and container gateway reachability.
  Do not alter the host proxy or add a public mirror silently.
- Plugin failure: inspect signature/import evidence, compatibility, requested
  permission, generation, migration and health. Roll back atomically to the
  previous healthy generation; never grant Docker/device access as a fix.
- LUKS mount absent or startup protection locked: follow the security/unlock
  runbook. Do not restart protected services against an empty fallback path.

## Escalation and recovery

Escalate when integrity/authentication fails, repeated restarts cannot reconcile
durable state, LUKS/header/device identity differs, the last owner is
unrecoverable, audit continuity breaks, a recovery/secret key is suspected
exposed, or maintenance enters `manual_recovery_required`. Preserve disks,
containers and evidence unchanged. Use isolated diagnostics
or the recorded rollback plan; do not experiment on the only copy.

Close an incident only after root cause and scope are recorded, credentials are
rotated if required, audit continuity is explained, authenticated HTTPS user
journeys pass, queues/realtime and core services survive, affected model/plugin
profiles are revalidated, and affected service recovery is verified.
