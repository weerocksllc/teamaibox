# Browser regression runbook

## Scope

This gate covers Simplified Chinese and English, Light and Dark themes, and
1440×900 desktop and 390×844 mobile-browser viewports. It covers the workbench,
administration surfaces, and all seven official ApplicationPlugins. The
machine-readable contract is
`architecture/validation/browser-regression-matrix.v1.json`.

## Build and fixtures

Build the current Web source with:

```sh
pnpm --filter @teamaibox/web build
```

Use `apps/web/tools/operations-preview-server.mjs` for ready, delayed loading,
empty, and injected-error states. Messaging and Team Drive have
test-only same-origin visual fixtures in their `test/visual-fixture-server.mjs`
files. These fixtures contain no production data and must never be packaged as
runtime services.

## Required browser checks

For every matrix combination, verify the actual viewport width, document
language, effective theme, absence of horizontal overflow and duplicate IDs,
and accessible names for all visible controls. Exercise long text, charts,
semantic tables, editors, loading, empty, error, focus, disabled, warning, and
exact-confirmation states. Check that official plugins load inside the host
iframe and receive locale/theme preferences.

Run the semantic theme contrast and repository evidence validators:

```sh
node --test apps/web/test/theme-system.test.mjs
python3 tools/validate_browser_regression.py
```

## Evidence boundary

Local HTTP fixture evidence is development regression evidence only. It must
set `releaseEvidenceEligible` to `false` and cannot replace task 15.11 evidence
from the supported containerized appliance over authenticated HTTPS in a real
browser. Screenshot digests document the transient visual review; a release
pipeline may retain full screenshots in its protected artifact store.

The separate release-appliance contract is
`architecture/validation/appliance-browser-acceptance.v1.json`. After a real
supported-appliance run produces a content-safe JSON report, validate it with:

```sh
python3 tools/validate_appliance_browser_acceptance.py \
  --evidence /protected/release/appliance-browser-report.json
```

It requires port 443 on the primary ARM64 appliance, browser trust-store
verification without a warning/custom-CA bypass, current host/hardware facts,
all eight locale/theme/viewport combinations, complete administrator and
ordinary-user journeys, and session/CSRF/SSE/WebSocket coverage. The validator
does not create a passing report; observations must come from the real browser
run.
