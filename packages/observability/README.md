# Observability

Shared correlation context, safe structured logging, metrics, tracing, and
redaction conventions. The platform operations service owns durable retention,
dashboard authorization, health policy, alerts, and diagnostic export.

Every inbound request receives a validated or newly generated correlation ID,
which is propagated through asynchronous work and returned in the
`x-correlation-id` header. Platform errors expose stable codes and safe details;
unknown exceptions serialize as `internal_error`. Structured logs recursively
redact sensitive key names, byte material, authorization values, embedded
credentials, private keys, and secret-shaped assignments before writing one JSON
object per line. Diagnostic storage accepts only a separate, closed set of safe
facts; arbitrary request bodies and user content are not telemetry attributes.
