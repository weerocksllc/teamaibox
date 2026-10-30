# AI application end-to-end regression

## Scope

`architecture/validation/ai-application-e2e-suite.v1.json` is the closed
development regression contract for Assistant/Agent, AI Drawing, Text
Recognition, Speech Transcription, and Translation. Every
application is bound to its own UI/API integration tests and to the shared
durable-job, worker-lifecycle, object-handoff, authorization, and encryption
contracts. This prevents a shared scheduler test from passing while an
application adapter is missing the corresponding route or control.

The required scenarios are queued, preparing, running, cross-application
object handoff, cancellation, bounded error behavior, permissions, encrypted
output, mobile-browser layout, and model unload/reload.

## Run and verify

Use a new immutable run identifier for each evidence capture:

```sh
python3 tools/run_ai_application_e2e_suite.py \
  --run-id ai-applications-YYYYMMDD-name
python3 -m unittest tests.test_ai_application_e2e_suite -v
```

The runner stores only command and browser-artifact digests under
`evidence/validation/journeys/`; stdout and stderr are never retained. The
committed local-browser evidence is intentionally marked
`releaseEvidenceEligible: false`.

## Release boundary

This suite is development contract evidence. It does not replace current DGX
Spark model soak and coexistence evidence, or authenticated HTTPS journeys on
the supported containerized appliance required by task 15.11.
