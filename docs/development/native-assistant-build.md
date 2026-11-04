# Building the React Assistant

The Assistant is part of the existing Team AI Box web application. It does not
download or embed OpenCode's Web GUI. React, xterm.js, fonts, application assets
and their notices are included in the web image.

From the repository root, build all affected service and runtime image roles
using the public builder. Choose a new output directory:

```sh
assistant_build_dir=$(mktemp -d)
python3 install/build_public_services.py \
  --output "$assistant_build_dir/images" \
  --roles platform-api web node-agent agent-bridge agent-sandbox
```

The builder records exact ARM64 image IDs and the source commit in `images.json`.
These are affected-role build results, not a complete offline package or an
upgrade command. Follow the root README's installation workflow to prepare a
complete distribution. Do not run a fresh installer over existing user data.

The recipes install locked build dependencies. The Agent recipe verifies the
fixed upstream ARM64 archive before extraction. It includes OpenCode 1.19.5 and
the matching native plugin SDK; it does not patch the upstream execution engine.
The installer uses these same image roles. Building from source needs access to
the declared package and release sources; installing an already prepared offline
package does not repeat those downloads.

## Offline contents

The web image contains the compiled React application and local assets,
including `licenses/xterm.txt` and `licenses/native-config.txt`. The Agent image contains its native binary,
Git, ripgrep, the bridge and the locked plugin SDK dependency tree with notices.
New user configuration directories receive the bundled SDK only when no
user-owned package manifest or dependency directory already exists. Existing
user configuration and dependencies are not overwritten.

A local plugin can resolve the bundled SDK when installed in the native
configuration directory or below it. A plugin in a separate project needs its
own dependencies. Remote MCP servers, cloud model providers and user-installed
extensions can still require network access or an account. Offline installation
does not make those external services available offline.

## Scoped local verification

Check that the current source, engine recipes, native API, adapter and policy
agree before producing release images:

```sh
python3 tools/validate_opencode_compatibility_gate.py
```

This is a source-contract check, not runtime acceptance. For actual release
qualification, supply the external current-source-bound ARM64 summary using
`--require-release --evidence PATH`. A missing/failed/stale summary is rejected.
The active gate is v2; historical v1 receipts are retained without changing their
version or original outcome. No private validation helper or test record is
required to run the public source check.

With an already built local ARM64 image, this optional check starts a non-root
container with networking disabled and disposable memory-backed storage:

```sh
NATIVE_CANDIDATE_IMAGE=teamaibox-agent:local \
  node services/agent-bridge/test/native-offline-image-acceptance.mjs
```

It checks native startup, command discovery and a plugin using the bundled SDK.
It does not pull images, mount existing user data or contact an appliance. It
is an offline dependency check, not a substitute for conversation and permission
acceptance or installation qualification.

## Configuration form validation

The workspace configuration editor uses `jsonc-parser` 3.3.1 and a precompiled
validator derived from the pinned OpenCode Config schema. It checks the form
before writing, without changing source comments or resolving plugin dependencies.
The native engine still loads and executes the configuration.

Ajv 8.17.1 is a development dependency used only to generate the checked-in
validator. The browser does not compile schemas or use dynamic evaluation.
After an intentional upstream version/schema change, regenerate the validator
with `apps/web/tools/generate-native-config-validator.mjs`; verify it using:

```sh
node apps/web/tools/generate-native-config-validator.mjs --check
node --test apps/web/test/native-config-validation.test.mjs
```

Keep `native-config-schema.json`, the generated validator, pinned upstream
contract and shipped license notice in sync. Passing schema validation does not
prove that a referenced model, file, plugin or external service exists.

See the [capability map](native-assistant-capabilities.md) for the current
integration boundary and [storage guide](native-assistant-storage.md) for
per-user persistence and upgrade precautions.
