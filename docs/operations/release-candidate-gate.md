# Release candidate gate

## Applicability to the current handover

This document describes the separate machine-evaluated release-candidate
promotion mechanism; it is not a command to rerun accepted business tests for
documentation cleanup. The agreed 2026-10-21 functional handover is recorded in
the [delivery summary](../validation/single-appliance-delivery-20261019.md)
and [remaining list](../validation/remaining-work-20261019.md), including the
user-approved casting closure and completed Google/USB additions.

No new candidate evaluation or publication is claimed by that documentation
update. Existing gate reports keep their original identity and results. Do not
regenerate an old report to fabricate a pass, reopen an excluded test from its
historical backlog, or treat platform handover as Google certification or
Windows image redistribution permission. Use the mechanism below only when
the corresponding candidate-promotion work is actually in scope.

## Candidate promotion mechanism

No build becomes a release candidate because an individual test or demo
passed. `architecture/validation/release-candidate-gate.v1.json` is the closed,
release-blocking catalog and `tools/run_release_candidate_gate.py` is its
evaluator. It emits redacted evidence; it does not mutate a deployment or
publish an image.

## Required command gates

The evaluator runs strict OpenSpec validation, the complete Node and Python CI
suites, module/supply-chain validation, and the no-regression journey/load/docs/
environment/browser checks. The worktree must be clean. Command output is hashed and
discarded; any non-zero exit, timeout, missing command, or catalog drift blocks
promotion.

## Required appliance evidence

The candidate manifest must bind every evidence envelope to the exact release
digest, source revision/tree digest, environment digest, and candidate ID. It
requires one current real-Spark smoke, one or more Certified model profiles, a
risk-selected completed soak for every certified profile, an independent
the closed
security gate, and a successful upgrade and rollback rehearsal.

The manifest also requires exactly one appliance-acceptance envelope. It must
bind a supported ARM64 containerized deployment, a conforming host-allowlist
snapshot, Spark hardware-sensitive checkpoints collected no more than one hour
before the journey, and administrator plus ordinary-user journeys executed in a
real browser over a browser-trusted HTTPS origin. The gate rejects `file://`,
localhost, plain HTTP, an untrusted development CA, missing role coverage, or a
relabelled local fixture. Those claims must be derived exactly from one report
that passes `tools/validate_appliance_browser_acceptance.py` against
`architecture/validation/appliance-browser-acceptance.v1.json`; arbitrary true
flags or plausible-looking digests are rejected.

Every envelope is itself content-digest checked and references existing source
evidence by digest. Evidence may not be marked not-applicable. An 8-hour soak is
the minimum; a critical, high-memory, or NVFP4 profile requires 24 hours. Smoke
soaks cannot pass. Model profile IDs must match one-to-one between certification
and soak envelopes.

## Evaluate

Create a manifest outside the source tree or under a release evidence staging
directory, then run:

```sh
python3 tools/run_release_candidate_gate.py \
  --manifest /absolute/path/release-candidate-manifest.json \
  --run-id release-YYYYMMDD-name
```

The evaluator writes `evidence/validation/releases/<run-id>.json`. Promotion is
eligible only when `status` is `passed`, `promotionEligible` is true, the failed
gate list is empty, and a separate release publisher verifies the result digest
and signature/provenance policy. A failed report is diagnostic evidence, never
an override token.
