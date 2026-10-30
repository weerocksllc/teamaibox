# Operational diagnostics, health, and alert boundary

Task 14.4 adds a durable operations plane around the existing local appliance
dashboard. It treats telemetry as bounded operational evidence, not as another
copy of application requests or team data.

## Signal contract and redaction

`OperationalDiagnosticsService` accepts three signal kinds: structured logs,
numeric metrics, and timed traces. Every record has a validated correlation ID,
a producer kind/key, a stable event key, an observation time, and only facts
from a closed scalar allowlist. Prompt text, request bodies, filenames, model
inputs/outputs, shell commands, arbitrary error responses, and credentials are
not accepted as diagnostic facts. The shared redactor also removes sensitive
key names, byte material, authorization values, embedded URI credentials,
private-key blocks, JWT-shaped values, and secret assignments before logs leave
a process.

PostgreSQL migration 50 persists bounded records in:

- `platform.diagnostic_signals` for redacted logs, metrics, and traces;
- `platform.health_signals` for append-only target observations;
- `platform.operational_alerts` for open/resolved alert lifecycle and links;
- `platform.diagnostic_exports` for export metadata and content digests only.

The database stores export metadata, counts, filters, and SHA-256 digest. It
does not store a second plaintext copy of an exported bundle or sensitive user
content.

## Health and circuit breakers

Core services, plugins, nodes, workers, external providers, software sources,
storage pools, and network links use one target vocabulary. Provider contract
tests, Source Center health reports, and storage-pool observations publish into
the operations plane through optional health sinks. A degraded or unavailable
observation opens or refreshes one durable alert; a healthy observation resolves
it while retaining history until expiry.

`WorkerObservabilityEventSink` composes with the scheduler's durable lifecycle
event sink. The scheduler remains authoritative for crash thresholds and stops
rescheduling while its circuit is open. The observer records lifecycle facts,
resolves attempt-to-job links from earlier execution signals, and opens a
critical alert that links the redacted signals and affected job identifiers.
Telemetry failure is reported separately and cannot replace or bypass durable
scheduler event persistence. Provider, source, and storage health sinks use the
same isolation rule: a diagnostics outage is recorded as a bounded publish
failure but does not turn an already committed primary health update into a
client-visible failure or unsafe retry.

Managed-node heartbeats also project node and declared network-link health,
accepted metric snapshots project node and core-service health, and plugin
lifecycle probes project plugin health. These adapters run only after their
authoritative state has committed, use the same closed/redacted fact model, and
isolate both diagnostics-sink and diagnostics-error-reporting failures from the
heartbeat, metric, and plugin control paths.

## Access and export

- `operations:view` permits health, alerts, correlation lookup, and ordinary
  diagnostic export.
- `operations:manage` additionally permits retention execution.
- `diagnostic_sensitive:view` is granted only to Owner and System Administrator.
  It is required in addition to `operations:view`, a specific 8–256 character
  reason, and an explicitly configured sensitive-content source.

Ordinary exports always contain an empty `sensitiveContent` array. An explicitly
authorized export may ask the separate content source for at most 100 referenced
items; the operation is audited with actor, reason, bundle ID, and digest. Secret
redaction remains active even for that path. The browser never renders returned
sensitive content; it downloads the authorized bundle directly.

All state-changing HTTP routes are HTTPS, same-origin, authenticated, and CSRF
protected:

- `GET /api/v1/admin/operations/health`
- `GET /api/v1/admin/operations/alerts`
- `GET /api/v1/admin/operations/correlations/{correlationId}`
- `POST /api/v1/admin/operations/diagnostic-exports`
- `POST /api/v1/admin/operations/retention/run`

The stable response contract is
`packages/contracts/http/diagnostic-bundle.v1.schema.json`.

## Retention

Defaults are 14 days for logs and traces, 30 days for metrics and health, seven
days for export metadata, and 90 days for resolved alerts. Policy values are
constructor configuration constrained to 1–3650 days. Cleanup uses independent
cutoffs by record class and emits an administrative audit event with deletion
counts. Open alerts are never deleted by the retention sweep, and signals still
referenced by retained health evidence or open alerts are protected from signal
expiry until those references are no longer live.

