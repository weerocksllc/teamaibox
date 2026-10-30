# External provider contract testing

External OpenAI-compatible APIs are optional. They are configured by an
administrator; they are not managed devices, and none is required for the
local office applications to start.

The scheduler contract tests run against isolated local fixtures:

```sh
node --test services/scheduler/test/external-provider-contract-tester.test.mjs \
  services/scheduler/test/external-compute-e2e.test.mjs \
  services/scheduler/test/external-attempt-coordinator.test.mjs
```

These tests cover protocol compatibility, authentication failure, model
selection, cancellation/retry boundaries, and usage accounting. Simulated
responses are not evidence of a real external model's quality or capacity.

For a real provider, use the administrator External Compute page to register
the HTTPS endpoint, protected credential, allowed models and data policy.
Run its contract check before enabling routing. No hardware inventory,
SSH access, enrollment, remote Docker deployment or dedicated network link
is part of this workflow. Unknown provider hardware metrics remain unknown.

Do not send local-only files or prompts to an external endpoint. Keep tokens
and request/response content out of logs and diagnostic evidence.
