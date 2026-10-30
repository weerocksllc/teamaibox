# Team AI Box installation

## Release boundary

This runbook is for a fresh installation or a deployment change, not for
repeating acceptance on the already verified appliance. The current
[functional handover and limitations](../validation/single-appliance-delivery-20261019.md)
reuse accepted results. Documentation cleanup does not run this procedure,
format storage, replace guests or constitute a new release-candidate promotion.

Install only a signed, digest-pinned ARM64 release candidate whose release gate
identifies the same DGX Spark environment, image lock, migration set, plugin
set, and model profiles. The installation entry point is
`deploy/appliance/production.compose.yaml`, documented in
[single-appliance configuration](../../deploy/appliance/README.md). It uses
PostgreSQL identity and one local execution agent, not an in-memory owner.
The source refactor is not itself a successfully deployed release.

## Prerequisites

The supported baseline is NVIDIA DGX Spark/GB10 running the exact qualified
DGX OS, kernel, NVIDIA driver, Docker Engine, and NVIDIA Container Toolkit in
the [supported environment matrix](supported-environment-matrix.md). The host
is an appliance foundation. Do not install Node.js, Python packages, model
servers, databases, Web servers, Agent tools, or package mirrors on it; those
belong in bounded ARM64 containers. Host exceptions require a reviewed,
expiring allowlist record.

Before installation, initialize this appliance's record and check the release
compatibility contract, not the developer machine's full package/service
fingerprint. Follow [portable installation](portable-installation.md) for the
complete init, network preparation, import and role-scoped upgrade commands:

```sh
sudo python3 tools/appliance_compatibility.py --installation /etc/teamaibox/installation.json \
  --contract deploy/host/release-compatibility.v1.json
```

## Protected data root

Production persistence uses a separately mounted LUKS2 filesystem at a stable
path such as `/srv/teamaibox/data`. Prepare the layout described by
`deploy/storage/appliance-storage-layout.v1.json` with the declared ownership
and modes before starting Compose. The overlay never formats, unlocks, or
mounts a device. Do not use the Docker layer store, anonymous volumes, an
unencrypted root filesystem as the production data root.

Startup Unlock Protection is optional and off by default; data encryption is
not optional. An existing populated appliance follows the separately reviewed
LUKS2 production migration runbook, never an improvised conversion.

The production Platform API sets `PLATFORM_API_PERSISTENCE=postgres` and uses
discrete `PLATFORM_DATABASE_HOST`, `PLATFORM_DATABASE_PORT`,
`PLATFORM_DATABASE_NAME`, and `PLATFORM_DATABASE_USER` values. Put the database
password in a mode-`0400`/`0440` file mounted read-only and expose only its
absolute container path as `PLATFORM_DATABASE_PASSWORD_FILE`; connection URLs
are rejected. Database TLS defaults to `verify-full` and requires
`PLATFORM_DATABASE_CA_FILE`. A composition using the isolated, single-host
Docker data network without PostgreSQL TLS must state
`PLATFORM_DATABASE_TLS_MODE=disable` explicitly. Generate an independent
32–128 byte audit HMAC key, encode it as unpadded base64url, mount it read-only,
and set `PLATFORM_AUDIT_SIGNING_KEY_FILE`; never reuse the database, setup,
object or node key.

## Secrets and configuration

Create independent random PostgreSQL and NATS secret files outside the source
tree, readable only by the deployment operator (`0600`). Generate a base64url
first-owner setup code with at least 32 random bytes, retain it in a separate
`0600` file exposed to the Platform API as
`PLATFORM_API_SETUP_TOKEN_FILE`, and deliver the plaintext code through the
appliance's separate trusted setup material. Keep TLS private keys, audit keys,
object wrapping keys, provider credentials, and setup
material in protected secret files or the release secret adapter. Never place a
secret in Compose YAML, an environment file, shell history, a URL, a log, or a
support bundle.

Set the installation-specific paths and validate the rendered deployment
before any start. Reuse the existing appliance UUID and data paths on upgrade:

```sh
docker compose --env-file /etc/teamaibox/installation.env --env-file /etc/teamaibox/networks.env \
  -f deploy/appliance/production.compose.yaml config --quiet
```

Validation must confirm Linux `arm64/v8` digest-pinned images, read-only
container filesystems, non-root/bounded service policy, internal control/data
networks, unpublished local execution-control ports, and protected bind volumes.

## Start and HTTPS ingress

Follow the signed release manifest's exact Compose command and image digests;
do not substitute `latest`, rebuild on the appliance, or pull an unrecorded
architecture. The public Web boundary and its Web server run in Docker. Publish
one authenticated HTTPS origin to the LAN and keep the raw API/database/queue
ports private. Plain HTTP may be used only for a non-credential health probe on
an isolated development host; sign-in cookies and CSRF protection require
HTTPS.

For a private appliance CA, follow [browser trust onboarding](browser-trust-onboarding.md):
export only the CA certificate, build the public-only fingerprinted handoff
bundle, distribute it through a separate authenticated channel, and install it
with operating-system administrator controls. Never distribute a CA private
key or ask a user to bypass a warning.

Use `appliance_setup.py prepare/apply` from the portable runbook so external
internal-network references are created/verified before Compose. Updates use
`appliance_delivery.py replace/resume/rollback`, never a developer's dated
deployment script. Record the local host baseline after installation; subsequent
drift checks use `/etc/teamaibox/host-baseline.json`, not `deploy/host/allowlist.v1.json`.

After services become healthy, complete [initial administrator setup](initial-admin-setup.md).
Then verify sign-in/sign-out, a normal user, team file upload/download/delete,
messaging, one queued compute job, task cancellation, dashboard telemetry,
and audit continuity.

## Install verification and rollback

Record release digest, host inventory digest, storage UUID/mount, certificate
fingerprint, service health, database migration head, audit head, and qualified model profiles. A release is not installed successfully
until an authenticated HTTPS browser journey passes.

On failure, stop admission, preserve logs and evidence, and use the release
manifest's previous slot/rollback instructions. Do not repair host packages or
database state ad hoc. If protected data may be inconsistent, keep it
unchanged and investigate against an isolated copy; never overwrite the sole source.
