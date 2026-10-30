# Unlock Service

This is the only Web service allowed before the production LUKS2 data volume
is open. It runs in a read-only, unprivileged ARM64 container and has access
only to its TLS material, a bounded redacted audit directory, and the exact
root-owned unlock-helper Unix socket. It has no database, object, model,
workspace, plugin, Docker socket, or protected-data-root mount.

The server accepts TLS 1.3 only and serves a self-contained Simplified
Chinese/English, Light/Dark unlock page. A same-origin, network-bound, one-time
challenge protects the passphrase POST. Possession of the valid LUKS2 Web
factor is the pre-unlock administrator authentication factor; the unavailable
team database is not mirrored into this domain. Failed factors are generic,
network-rate-limited, and recorded only as timestamp, action, outcome, request
ID, and SHA-256 network identifier. Passphrase bytes travel over a bounded
binary Unix-socket frame, are never command-line arguments or logs, and are
zeroed after the adapter call.

`GET /v1/status` deliberately exposes only locked/unlocking/unlocked/error,
unlock mode, bounded network interface status, and the caller's rate-limit
state. It cannot read or proxy protected application data. A successful POST
returns only an accepted `unlocking` transition; the privileged helper and
guarded protected-service transition are separate boundaries.

USB hardware-key integration has been retired. Automatic startup, Web
passphrase unlock and offline recovery remain supported. Historical hardware
mode metadata and existing slots are preserved; they are not converted to
automatic unlock. No SDK or USB device is required by a fresh installation.
