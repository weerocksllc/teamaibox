# Single-appliance browser-casting control plane

The Platform API owns casting sessions, invitations, audiences and viewer
grants. The trusted media runtime owns the local receiver, ephemeral pairing
state and one browser publisher connection to the internal SFU. All local
execution belongs to the exact configured `PLATFORM_APPLIANCE_NODE_ID`.
Retained records for other devices never authorize a remote execution target.

Browser playback is the only product output. Creation requires `cast:use` and
`cast:view`; sharing additionally requires `cast:share`. `cast:manage` permits
health inspection and forced stop, not silent viewing. If `outputSinks` is
supplied, only `["browser"]` is accepted. HDMI, mixed, empty and unknown output
requests are rejected before advertising a receiver. The runtime does not
acquire a display lease, take over GNOME or require local audio playback.

## Private callback boundary

`deploy/casting/trusted-media-callback-contract.v1.json` is a source contract,
not a declaration of live deployment. Its checked-in unbound identity cannot
authorize a runtime: activation requires an exact trusted-service certificate
and a dedicated private TLS 1.3 mTLS listener. These callbacks are not mounted
on the public browser listener, and forwarded certificate headers do not
establish service identity.

The private interface admits three `POST` operations:

- `.../source/pair`: validates the session PIN and source-connection identity.
- `.../source/streaming`: reports media only for the paired source identity.
- `.../viewers/authorize`: checks the current browser authorization without
  returning a replacement credential.

Every callback carries a UUID and canonical UTC issue time. A bounded
process-local replay window rejects reused IDs and stores only ID/expiry, not
request bodies or PIN-derived digests. Callbacks cannot bypass resource
admission or create an additional encoder for each viewer.

## Browser authorization and lifetime

`CastingSessionService`, `AuthenticatedCastingMediaAdmission` and the
same-origin signalling gateway bind the user, authenticated login session,
casting session, grant and exact browser instance. Each connection or
reconnection rechecks current `cast:view`, audience/team membership, grant
revision and session lifetime. A copied credential from another browser or
login is rejected without disconnecting the legitimate viewer.

Join credentials are short-lived and one-use at the signalling admission
boundary. An established viewer grant is bounded by the casting session's
expiry, not by the join credential's shorter lifetime. Connected viewers are
reauthorized periodically; loss of login, permission, audience or session
authority revokes access and removes the actual SFU participant. Failed
disconnects remain cleanup-pending and never count as successful revocation.

One and eight viewers are required acceptance test loads, not a hard-coded
product maximum. Runtime resource admission determines whether another viewer
fits. The database no longer rejects an authorized ninth viewer solely by
count. The media path keeps one encoded rendition and fans it out through the
SFU instead of allocating a hardware encoder per viewer.

## Local runtime, privacy and recovery

`services/trusted_media_runtime/appliance.py` owns the private control/SFU
gateways. `services/trusted_media_service/runtime_composition.py` composes the
paired receiver, private discovery, ingress and browser sink; it rejects legacy
physical-output configuration. Starting the service alone does not advertise a
receiver. A user session must first pass local resource admission without
evicting the protected office models or disrupting persistent guests.

Receiver readiness, Apple source/media activity and each browser's playback
state are independent. A running process or connected socket does not prove
actual audio/video. Source stop clears stale media without necessarily ending
the receiver session; explicit session stop revokes discovery, invitations,
credentials and viewers. Partial start/stop failures retain exact cleanup
ownership and expose the pending state. Recovery must not reset the GPU,
reboot the host or restart unrelated office/guest services automatically.

Durable state contains non-secret lifecycle, audience, authorization and audit
metadata only. PINs, receiver keys, source labels and media credentials remain
process-local; callback bodies and user media are not logged or recorded.
Migration 105 binds sessions to `appliance_node_id`, preserves historical
ownership where it resolves uniquely and rejects unsupported new outputs.
Historical records can still be stopped without rewriting their original
output facts; a schema recovery path is not permission to restore HDMI runtime.

## Verification boundary

Current usage is documented in the [casting guide](../operations/wireless-casting-guide.md).
Source, unit, synthetic-media and database checks establish only their measured
scope. Actual Apple-to-browser audio/video, supported device versions,
one/eight-viewer playback, timing, recovery and same-appliance coexistence need
their own exact current evidence. The [2026-09-07 snapshot](../validation/trusted-media-control-plane-20260907.md)
retains earlier component results and limitations; none is silently promoted
to current product acceptance.
