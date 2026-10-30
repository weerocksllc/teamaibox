# Continuous DGX Spark validation

`architecture/validation/spark-risk-matrix.v1.json` maps changed product areas
to the earliest useful real-appliance checks. Pure documentation and ordinary
local logic retain a fast local path; ARM64 images, Web transport, host/runtime,
GPU, unified-memory, storage/network, and appliance orchestration select bounded
Spark suites. LUKS/root-disk, firmware/Secure Boot and driver mutations
remain separately maintenance-gated.

Preview the selection without contacting the appliance:

```sh
python3 tools/spark_validation.py plan --changed apps/web/src/App.tsx
```

Run selected suites and write versioned evidence:

```sh
python3 tools/spark_validation.py run \
  --changed apps/web/src/App.tsx \
  --changed deploy/images/web.Dockerfile
```

The configured appliance is the only execution target. To select an applicable
bounded suite without changing the target:

```sh
python3 tools/spark_validation.py run \
  --suite database-smoke
```

The installation target binds one
allowlisted SSH endpoint, ARM64 architecture, and appliance-specific hardware
inventory digest into the resulting evidence. A mismatched or unknown binding
is rejected before remote work starts.

The runner accepts only committed targets and the `/tmp/teamaibox-validation-*`
staging prefix. It creates a source-content digest, rejects symlinked or escaped
staging input, copies one archive, runs fixed digest ARM64 containers with
explicit time/resource/security limits, and records sanitized output tails.
Suites that use a locked runtime first require that exact ARM64 image to be
preloaded. In particular, the database smoke uses `--pull never`; a cold or
offline node fails quickly as not prewarmed instead of asking Docker to fetch a
replacement or floating image.
Cleanup names every created container/image and removes only the exact staging
directory; label/path residual checks run even after failure.

A required failure, current host drift, manual-maintenance gate, cleanup error,
or any residual container/image/path sets `claimEligible=false`. The failed
increment must not be described as verified until a later evidence run passes.
HTTP Web checks apply only to the isolated preview. The suite also starts a
temporary release-mode HTTPS container with an ephemeral certificate to verify
TLS/HSTS behavior, but full authenticated trusted-certificate browser journeys
remain a release gate.

The designated Spark currently reaches the administrator's approved Internet
path through host networking while Docker's default bridge DNS does not. The Web
suite therefore permits `docker build --network host` only for the reviewed
multi-stage dependency/build steps, which use exact package versions, the
committed lock, and disabled install scripts. Runtime Web, API, plugin, Agent,
and model containers do not inherit host networking. The build mode and failed
bridge-DNS run remain explicit evidence. If neither this approved path nor the
internal NPM gateway is available, the separately documented prebuilt-assets
development fallback can be selected without installing host dependencies.
