# Containerized Web boundary

The Web workbench is built and served entirely in the pinned ARM64 image defined
by `deploy/images/web.Dockerfile`. The Spark host does not need Node, Pnpm, a Web
server, or frontend build packages. The runtime is non-root, read-only,
capability-free, health checked, and resource bounded.

Official application plugins are separate non-root OCI containers. The edge
loads an exact `WEB_PLUGIN_ROUTES_FILE`; each route must be the unique
`/plugins/<plugin-id>` path derived from a namespaced identifier. Only GET/HEAD
asset requests cross this boundary, and the edge strips Cookie, Authorization,
CSRF, Origin, and Referer before forwarding to a plugin container. The iframe
calls protected platform APIs through the edge itself, so plugins never receive
browser session credentials at their container ingress.

When the Spark container network cannot reach either the internal NPM gateway or
the approved Internet upstream, `web-prebuilt.Dockerfile` is the development-only
fallback. The workstation first runs the committed Pnpm lock and bundle verifier;
the resulting static directory is content-digested and staged, and Spark builds
the final ARM64 runtime image without downloading dependencies. Evidence records
both stages. Release CI still uses the full multi-stage Dockerfile or a verified
internal source gateway; the fallback does not weaken the registry-digest release
requirement.

## Development HTTP

`development.compose.yaml` exposes one explicitly named HTTP preview. It is only
for isolated development without credentials, sessions, team data, administrator
operations, or unlock/security functions. `WEB_DEVELOPMENT_DEMO=true` is an
explicit preview-only switch; it is rejected in release mode. A development
result is never release evidence.

Build on the ARM64 target and select the immutable local image ID:

```sh
docker build --platform linux/arm64/v8 \
  --file deploy/images/web.Dockerfile \
  --tag teamaibox/web:development .
docker image inspect --format '{{.Id}}' teamaibox/web:development
```

Pass that exact `sha256:...` ID as `TEAMAIBOX_WEB_IMAGE`, set the appliance HTTP
origin, then render and start `development.compose.yaml`. Retained development
containers use a source/image release identifier and a documented port so the
next run can replace or remove only that exact deployment.

## Release HTTPS and certificates

Release images are published and selected by registry manifest digest. The
certificate chain and private key are mounted as Docker secrets into `web-edge`;
the key is never copied into an image or environment variable. `WEB_PUBLIC_ORIGIN`
must be an `https://` origin. The certificate must be valid at startup, otherwise
the edge refuses to start. The first certificate in the mounted chain must be a
server leaf whose DNS/IP subject alternative name matches the exact public
origin; a CA certificate used as the leaf or a mismatched private key is
rejected. After atomically replacing both certificate files, send `SIGHUP` to
`web-edge`. A parse, validity, name, leaf-role, or key-pair failure is logged by
code and the existing TLS context stays active. Administrators must renew early
enough to avoid expiry and maintain the appliance hostname/IP trust instructions
used by team browsers.

## Authenticated HTTPS integration on Spark

`tools/deploy_spark_authenticated_preview.py` exercises the real ARM64 Web and
Platform API images before the durable production identity repository is ready.
It is intentionally separate from the release compose contract:

- the Web and Platform API dependency stages use the Spark host network so they
  can use the selected Internet/internal NPM gateway; both use the frozen Pnpm
  lock, the API disables lifecycle scripts, and neither runtime receives that
  build-time egress;
- the Platform API joins only an internal Docker bridge and exposes no host
  port;
- the Web joins that API bridge plus a published edge bridge with IP
  masquerading disabled, so LAN clients can connect without granting ordinary
  NAT egress to the Web container;
- bootstrap credentials, the one-time setup proof, and TLS material use
  separate, read-only, run-scoped named volumes; none is placed in an image or
  environment variable;
- both runtimes are ARM64, non-root, read-only, capability-free, bounded, and
  candidate-health-checked before the retained slot is switched;
- before candidate setup, an offline non-root/read-only API probe proves that a
  production process with no explicit persistence mode exits nonzero, emits
  only the redacted structured failure, and leaves no container residual;
- a separately published candidate slot exercises protected first-owner setup,
  wrong-proof and cross-origin rejection, eight one-time recovery codes,
  one-owner idempotency, and the new owner's first sign-in; the candidate
  containers, setup-proof volume, local proof file, and temporary port are
  removed before the stable blue/green switch;
- the workstation smoke client trusts only the generated run CA and verifies
  HTTPS, sign-in, session permissions, CSRF rejection/acceptance, preference
  writes, SSE, WebSocket, sign-out, and session invalidation.

Run it directly from the repository root:

```sh
python3 tools/deploy_spark_authenticated_preview.py deploy
python3 tools/deploy_spark_authenticated_preview.py status
python3 tools/deploy_spark_authenticated_preview.py rollback
```

The same complete HTTPS integration stack can run on the explicitly allowlisted
second development Spark while the primary Spark is occupied by a
hardware-sensitive model run:

```sh
python3 tools/deploy_spark_authenticated_preview.py deploy \
  --target dgx-spark-worker-02 \
  --run-id auth-worker02-YYYYMMDD-a1
python3 tools/deploy_spark_authenticated_preview.py status \
  --target dgx-spark-worker-02
```

The selected target determines both the SSH destination and the certificate IP
subject alternative name. Arbitrary SSH destinations and certificate addresses
are rejected; status and rollback use the same explicit target selector.
If the worker cannot reach the registry, preload the exact locked ARM64 Node
image and provide its complete local `sha256:...` image ID through
`--local-base-image-id`. The deployment verifies the ID and architecture,
creates a run-scoped temporary alias, removes that alias after the build, and
records both the original registry lock and the local content ID in evidence.

Each successful run stores its generated development CA and mode-`0600`
bootstrap credential file under ignored `.runtime/authenticated-preview/<run>/`
and writes a secret-free evidence JSON under `evidence/platform/`. The setup
proof is deleted even on failure and is never part of the evidence. Do not trust
the development CA system-wide without an explicit administrator decision.
Until a browser trusts that CA or the edge has a certificate from an already
trusted authority, browser authentication remains blocked and the run is not
release evidence. The current integration API explicitly declares its
development-only `PLATFORM_API_PERSISTENCE=memory` mode; all team or durable
account data remains prohibited from this preview.

The isolated HTTP preview can also be placed on either explicitly allowlisted
development Spark. This is useful while the primary box is occupied by a
hardware-sensitive soak: the UI remains containerized on the second box and the
selected LAN address is written into both runtime configuration and evidence.

```sh
python3 tools/deploy_spark_web_preview.py deploy \
  --target dgx-spark-worker-02 \
  --run-id web-worker02-20260812-a1
python3 tools/deploy_spark_web_preview.py status \
  --target dgx-spark-worker-02
```

If that Spark's Docker daemon cannot reach the registry, preload the exact
locked ARM64 image through an approved offline transfer and pass its complete
local `sha256:...` image ID with `--local-base-image-id`. Mutable tags are
rejected. Deployment evidence keeps both the repository digest lock and the
actual local image ID used by BuildKit.

This remains an isolated development surface without protected data or release
credentials. It does not replace the authenticated HTTPS appliance gate.

## Blue/green switch and rollback

`compose.yaml` keeps `web-blue` and `web-green` on an internal network. Each slot
uses its own release identifier and exact registry digest. `web-edge` is the only
published endpoint; it terminates HTTPS, applies headers, proxies platform
API/SSE/WebSocket routes, and forwards application assets/routes to the selected
slot.

For a change from blue to green:

1. Keep the currently active blue image and origin in the deployment record.
2. Set the green candidate digest/release, start or recreate `web-green`, and
   require its `/health/ready` plus asset and SPA smoke tests to pass.
3. Set `TEAMAIBOX_ACTIVE_WEB_ORIGIN=http://web-green:8080` and recreate only
   `web-edge`; require its HTTPS health and browser journey to pass.
4. Retain blue through the rollback window. If an edge or browser gate fails,
   restore `http://web-blue:8080`, recreate only `web-edge`, and verify health.
5. Remove the superseded slot image only after the rollback window and evidence
   retention policy complete.

The active/previous slot, image digests, release IDs, certificate fingerprint,
test URLs, results, and rollback result belong in versioned deployment evidence.
