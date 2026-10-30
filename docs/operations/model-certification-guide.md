# Model certification guide

## Certification identity

Certification applies to one immutable model profile: artifact digests,
license decision, engine image digest/configuration, architecture, precision,
quantization, context/input limits, workload class, environment ranges,
resource envelope, exclusivity/coexistence policy, and validation suite. A
model name, repository branch, floating tag, or successful one-off prompt is
not a certified profile.

NVFP4 is preferred on DGX Spark only when the exact model and engine publish a
real NVFP4 path and the measured profile passes. NVFP4, MXFP4, FP8, BF16, and
FP16 are not interchangeable. GB10 capability alone is not evidence that an
arbitrary model can run in NVFP4.

## Pipeline

1. **Discover and license:** record source, revision, file digests, license,
   redistribution/use constraints, intended operation, and human acceptance
   where required.
2. **Import:** stream/resume into protected model storage, verify every chunk
   and final digest, quarantine mismatch or interrupted artifacts, and expose
   no source credential.
3. **Build engine:** run a reproducible, digest-pinned ARM64 engine job in a
   bounded worker container; preserve recipe, logs digest, environment and
   output artifact lineage.
4. **Register profile:** create the immutable profile before validation. Any
   changed engine, tensor, flag, precision, limit, driver range, or resource
   envelope creates a new profile.
5. **Conformance and quality:** run every claimed Compute API behavior,
   structured output, streaming/cancellation/idempotency where applicable, and
   task-specific quality fixtures. Compare quantized output with the designated
   higher-precision reference and record acceptance thresholds.
6. **Performance and memory:** measure cold load, warm latency/throughput,
   unified-memory peak/headroom, CPU, storage I/O, network, and OOM behavior at
   declared input/concurrency limits. Observe actual core-service health; no
   advance resource pool or fixed core-service reservation is required.
7. **Faults and soak:** inject safe worker/request failures, validate retry and
   cancellation, then run the selected 8- or 24-hour soak with immutable probe
   inputs, bounded quality checks, telemetry and zero unexplained failures.
8. **Coexistence/exclusivity:** prove declared combinations under real load. If
   a profile cannot preserve core services or peers, certify it node-exclusive
   and prove drain/wake/unload/recovery instead.
9. **Approve and route:** sign evidence, record reviewer and validity range,
   change lifecycle from Experimental to Certified, and enable only the tested
   logical operations. Missing/stale evidence keeps production routing off.

## Local and external profiles

Local qualification applies to the installed appliance and its actual resource
budget. All local workers execute on that appliance. Large recordings use the
local engine's supported input handling and queue; another device is not an
execution target or a certification prerequisite.

External OpenAI-compatible providers are registered as separate provider/model
profiles. Certify endpoint compatibility, credentials/CA handling, data-class
policy, rate/limit behavior, cancellation, retry ambiguity, billing/usage
facts, object transfer, and output validation. Private hardware metrics absent
from the contract remain `unsupported`.

## Revalidation and revocation

Artifact, engine, driver, CUDA interface, kernel, firmware, runtime, security
policy, environment range, or validation-suite drift changes the profile to
`revalidation_required` and fences new strict routing. Only a new complete
passing validation run returns it to Certified. Revoke immediately for license,
integrity, safety, repeatable quality, or security failure; preserve prior
evidence and audit history.

Use the executable model baseline, fault, soak, coexistence, comparison, and
API-conformance tools documented under `docs/operations`. Certification
evidence must come from the named Spark hardware when the claim is
hardware-sensitive; local unit tests are not a substitute.
