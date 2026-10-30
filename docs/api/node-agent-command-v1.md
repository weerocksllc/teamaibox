# Node Agent command API v1

The Node Agent is an internal local-execution interface, not a browser or plugin
API. It listens on HTTPS with TLS 1.3 and requires a client certificate chaining
to the configured scheduler/control-plane CA.

## Authentication

`POST /v1/commands` accepts the published
`node-agent/command-envelope.v1.schema.json` body and these protected transport
headers:

- `X-Teamaibox-Key-Id`
- `X-Teamaibox-Nonce`
- `X-Teamaibox-Signature`

The signature is base64url-without-padding HMAC-SHA256 over:

```text
<key-id>\n<nonce>\n<exact JSON command envelope bytes>
```

The service verifies protocol version, exact node ID, issue/deadline window,
key ID, constant-time signature, and nonce replay state before consulting the
command cache or Docker runtime. A nonce may repeat only for the identical
command ID. Secrets are mounted as files and are never command payload fields.

Every worker command requires a current `leaseId` and positive `fencingToken`.
A token below the highest observed token for that lease is rejected. The same
command ID and body returns its prior result; reusing the ID with changed facts
is a conflict.

## Commands

### `worker.start`

The payload identifies worker, attempt, immutable model profile, digest-pinned
image, network, resource limits, security baseline, named volumes, approved
device classes, file-reference environment, and argument-vector command. The
agent validates all policy before calling Docker.

The Docker create request always applies:

- non-root user and read-only root filesystem;
- `CapDrop: ALL` and `no-new-privileges`;
- memory = memory-swap, CPU quota/period, PID and `nofile` limits;
- bounded noexec/nosuid/nodev tmpfs at `/tmp`;
- restart disabled and only the declared non-host network;
- named volumes only and a scheduler-approved NVIDIA device request;
- complete ownership/fencing/image labels.

### `worker.health`

Inspects only the deterministic managed-worker container name and verifies all
ownership/fencing labels before returning Docker state and health.

### `worker.stop`

Performs the same ownership check, applies a bounded 0–300 second grace period,
stops a running worker, and removes its container. It cannot address arbitrary
container names.

## Events and errors

Successful start/stop/health and failed commands emit ordered v1 worker events
containing node, worker, attempt/lease where applicable, fence, correlation,
timestamp, and a bounded payload. Authentication failures return generic error
documents and never include stored keys, Docker responses, or private runtime
details.

`GET /health/live` reports process liveness. `GET /health/ready` calls the
Docker Engine `/version` endpoint with a short deadline. The HTTPS server's own
container healthcheck uses a separate client certificate.

