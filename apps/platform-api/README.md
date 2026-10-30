# Platform API

Trusted browser/plugin API and modular control-plane transaction boundary. Its
internal modules will own local identity, authorization, platform
configuration, capability/model/provider/plugin registries, jobs and attempts,
file metadata/ACL, and audit references.

It does not control Docker/devices, store object bytes, execute models, proxy
OpenCode directly, or use the event bus as the only durable source of truth.

## Authenticated integration boundary

`server/platform-api.mjs` is the containerized browser-session integration
boundary used while durable control-plane repositories are being built. It
accepts only an HTTPS public origin forwarded by the Web boundary and provides
local sign-in/sign-out, host-only Secure cookies, double-submit CSRF protection,
account locale/theme preferences, an authenticated SSE event, and an
authenticated WebSocket upgrade. The API container is never published on a
Spark host port.

The entry point uses `MemoryIdentityRepository` only when no durable database or
explicit identity repository is injected. Development preview restarts therefore
invalidate sessions and recreate the preview owner. A supported composition
injects the transactional PostgreSQL adapter; owner bootstrap, lockout state,
preferences, recovery generations, and session revocation then survive process
and container restarts on the encrypted appliance data root. Once the bootstrap
transaction is present, restart no longer requires reading the one-time bootstrap
secret file. The preview remains development-only because its composition does
not inject that database boundary.

An uninitialized supported composition serves the first-owner setup API only
when `PLATFORM_API_SETUP_TOKEN_FILE` or an equivalent protected authority is
injected. The high-entropy device proof is verified before password hashing and
never enters logs or durable identity state. Without that authority, remote
owner creation is disabled even though setup status remains visible. The eight
recovery codes are returned by the successful HTTPS response once and must be
saved before leaving the setup surface.

The ARM64 runtime image is `deploy/images/platform-api.Dockerfile`. Its build
stage installs the exact frozen production dependency graph with lifecycle
scripts disabled; the final stage uses the digest-locked Node runtime and runs
as `1000:1000` without package tools or writable application files. Build
network access must use the selected NPM source policy/gateway and is never
available to the runtime container.

`server/appliance-main.mjs` is the production container entrypoint and composes
the single-appliance dependencies around `server/main.mjs`. Memory persistence is
the explicit development default; a production process refuses to start when
`PLATFORM_API_PERSISTENCE` is omitted. The authenticated preview declares
`PLATFORM_API_PERSISTENCE=memory`, while `PLATFORM_API_PERSISTENCE=postgres` loads the
pooled transactional adapter from `packages/persistence`, verifies readiness
before opening HTTP, and requires `PLATFORM_AUDIT_SIGNING_KEY_FILE`. Database
URLs are rejected so passwords cannot enter command lines, environment URLs,
or process listings. Use the discrete host/port/name/user settings plus
`PLATFORM_DATABASE_PASSWORD_FILE`. TLS defaults to `verify-full` with
`PLATFORM_DATABASE_CA_FILE`; the single-host internal Docker data network may
explicitly select `PLATFORM_DATABASE_TLS_MODE=disable` only as part of the
reviewed appliance composition.

## Compute HTTP boundary

`src/compute/compute-http-api.mjs` implements the selected authenticated
OpenAI-compatible routes plus the versioned OCR, translation, job, and realtime
admission extensions. `server/platform-api.mjs` accepts either an authorized
browser session with same-origin CSRF or a scoped developer/service Bearer
credential and renders JSON or SSE without exposing physical routing.

The adapter requires an injected compute backend. Every non-realtime backend
method must cross the durable acceptance boundary before invoking or streaming
a worker; the durable queue implementation is task 5.3. Without an injected
backend, compute routes fail explicitly with `503 compute_unavailable`.

The public v1 route and schema reference is
`docs/api/compute-api-v1.md`.

## Update and host-maintenance boundary

`src/updates/maintenance-workflow-service.mjs` separates platform releases
from OS/kernel/driver/firmware/runtime maintenance. The only deployment
strategy is `single_node_downtime`: verify compatibility checks,
drain affected local work, perform the exact local update, then run health and
data-persistence checks. Failure follows the recorded local rollback/recovery
plan; it must not reset guest data.

Host changes remain restricted by `src/host/host-maintenance-policy.mjs`.
The runtime config contains one loopback `endpoint`, not an endpoint catalog.
See `docs/architecture/platform-update-and-host-maintenance.md`.

## Protected browser object adapter

`src/objects/object-http-api.mjs` adapts authenticated browser uploads and
selection to the protected object service. A raw upload is size bounded,
requires a caller-computed SHA-256 digest, commits only after storage-side
verification, and returns a ten-minute capability-scoped reference identifier.
It never returns the signed grant token, storage endpoint, or credential.
Listing is restricted to the caller's user namespace; a selected immutable
object version can be re-scoped for image, OCR, ASR, or translation compute.
Reference content supports HEAD, full download, and a single bounded byte range.

The adapter is enabled only when `startPlatformApi` receives a production
`objectService` dependency. It checks local session, same-origin CSRF on every
mutation, and `file:read`/`file:write` independently of AI permission.

## Durable job service

`src/compute/durable-job-service.mjs` canonicalizes idempotent request facts,
persists request/results through the protected object service, owns job
progress/cancellation/deadline/terminal transitions, and exposes the backend
used by the HTTP adapter. `src/compute/postgres-durable-job-repository.mjs`
implements transactional PostgreSQL admission with owner/capability locks and
quota checks. The memory repository is test-only. See
`docs/architecture/durable-compute-queue.md`.

## Appliance runtime configuration

`server/appliance-main.mjs` composes the production API for one appliance.
`PLATFORM_APPLIANCE_NODE_ID` is the stable installation UUID;
`PLATFORM_APPLIANCE_NODE_KEY` matches the DNS identity in the local Agent
certificate. `PLATFORM_APPLIANCE_AGENT_HOST` must resolve to loopback. The API
uses `PLATFORM_APPLIANCE_AGENT_CERT_FILE` to read the Agent's public
certificate; it is not the API client's certificate.

The administrator device page is `/admin/device`, backed by
`GET /api/v1/admin/appliance`. It reports this appliance's service and resource
state. It does not enroll or manage remote boxes. Existing local guest IDs,
volumes, and database records are retained when API/Agent services restart.

Installation configuration belongs under `deploy/appliance`. The production
image does not embed a test appliance address, test users, fixed model endpoints,
or an SSH provisioner. Browser camera/UDP configuration uses the installed
`PLATFORM_APPLIANCE_LAN_ADDRESS` or the LAN address in
`PLATFORM_API_PUBLIC_ORIGIN`; it must identify this appliance.
