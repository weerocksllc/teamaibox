# External OpenAI-compatible provider registry

External A100, H200, or other LAN/cloud services join the logical compute pool
as `external_openai` providers. These are API integrations only: the platform never
claims their CPU, GPU, memory, temperature, power, or hardware topology. Their
resource accounting is limited to configured concurrency/rate contracts and
later observed request usage.

Only an administrator with `provider:manage` can register or mutate a provider.
Registration requires:

- an HTTPS endpoint without URL credentials, query, or fragment;
- `none`, bearer, or named API-key-header authentication;
- system CA or a protected custom CA bundle and optional TLS server name;
- one or more logical model-profile mappings with exact provider model name,
  operations, context window, output limit, enable state, and routing weight;
- allowed data classifications;
- concurrency, requests/minute, optional tokens/minute, connect/request/stream
  timeouts, and bounded health policy;
- currency, token/image/audio prices, and whether accounting is reported,
  estimated, or intentionally unpriced.

Authentication credentials and custom CA bundles are stored in the encrypted
Secret Store with `provider-adapter` as the only runtime reader. PostgreSQL
stores protected references and redacted configuration, never secret values.
If durable registration fails after secret provisioning, every new secret is
revoked. Rotation creates a new protected version and returns only version
metadata.

Providers begin disabled and untested. The contract tester authenticates using
the protected callback, applies the configured TLS trust, checks the health
endpoint and `/models`, confirms every enabled model name, and runs a bounded
probe for every declared operation. OCR/audio mappings require an explicit
fixture provider; missing fixtures fail rather than silently accepting a
declaration. The durable result contains only check identifiers, status,
latency, and a SHA-256 evidence digest—never response bodies, prompts, generated
content, endpoints with credentials, headers, or secret bytes.

Passing a contract test does not automatically enable a newly registered
provider. Enablement is a separate revision-fenced administrator action. Health
and contract-run rows are append-only. A failed or stale contract makes the
provider ineligible; routing modes and acceptance-aware execution are added by
the subsequent routing/failover increments.

