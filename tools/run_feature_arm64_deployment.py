#!/usr/bin/env python3
"""Deploy one exact feature increment to an allowlisted ARM64 Spark, fail closed."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import sys
import tarfile
import tempfile
import time
from typing import Any, Mapping, Protocol, Sequence


ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / "architecture" / "validation" / "feature-deployment-runner.v1.json"
CATALOG = ROOT / "architecture" / "validation" / "feature-acceptance-catalog.v1.json"
EVIDENCE_ROOT = ROOT / "evidence" / "validation" / "feature-deployments"
SAFE_RUN_ID = re.compile(r"^[a-z0-9][a-z0-9-]{7,63}$")
SAFE_NAME = re.compile(r"^[a-z][a-z0-9-]{1,63}$")
SAFE_ENV = re.compile(r"^[A-Z][A-Z0-9_]{1,63}$")
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
OCI = re.compile(r"^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$")
SOURCE_EXCLUSIONS = {".git", ".pnpm-store", "node_modules", "dist", "__pycache__"}
SENSITIVE_ENV = re.compile(r"(?:PASSWORD|TOKEN|SECRET|PRIVATE|CREDENTIAL|COOKIE|AUTH)")

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.spark_validation import CommandResult, RemoteSpark, SparkValidationError


class FeatureDeploymentError(RuntimeError):
    pass


class Remote(Protocol):
    def run(self, command: Sequence[str], timeout: int = 30) -> CommandResult: ...
    def copy(self, local_path: Path, remote_path: str, timeout: int = 60) -> CommandResult: ...


def require(condition: bool, message: str) -> None:
    if not condition:
        raise FeatureDeploymentError(message)


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def digest_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def load_policy() -> dict[str, Any]:
    value = json.loads(POLICY.read_text(encoding="utf-8"))
    require(value.get("schemaVersion") == 1 and value.get("runnerId") == "teamaibox.feature-deploy.v1",
            "feature deployment runner policy identity drifted")
    require(value.get("architecture") == "linux/arm64/v8", "feature deployment architecture drifted")
    require(set(value.get("allowedTargets", {})) == {"dgx-spark-dev-01"},
            "feature deployment target allowlist drifted")
    require(value.get("remoteStagingPrefix") == "/tmp/teamaibox-feature-", "remote staging prefix drifted")
    require(value.get("remoteDeploymentPrefix") == "/var/lib/teamaibox-feature-deployments/",
            "remote deployment prefix drifted")
    require(value.get("composeProjectPrefix") == "teamaibox_feature_", "compose project prefix drifted")
    for target in value["allowedTargets"].values():
        require(isinstance(target, Mapping) and set(target) == {"ssh", "address", "deploymentOwner"}
                and target.get("deploymentOwner") == "d",
                "feature deployment target ownership drifted")
    return value


def _safe_relative(value: Any, label: str, prefixes: Sequence[str]) -> Path:
    require(isinstance(value, str) and value, f"{label} is missing")
    pure = PurePosixPath(value)
    require(not pure.is_absolute() and ".." not in pure.parts, f"{label} escapes the repository")
    require(any(value == prefix or value.startswith(prefix) for prefix in prefixes), f"{label} is outside the source allowlist")
    path = ROOT / pure
    require(path.exists(), f"{label} does not exist: {value}")
    return path


def _command(value: Any, label: str, *, minimum: int = 1) -> list[str]:
    require(isinstance(value, list) and len(value) >= minimum, f"{label} command is missing")
    require(all(isinstance(item, str) and item and "\0" not in item for item in value), f"{label} command is invalid")
    return list(value)


def _check_declaration(value: Any, label: str) -> dict[str, Any]:
    require(isinstance(value, Mapping) and set(value) == {"key", "command", "timeoutSeconds"}, f"{label} fields drifted")
    require(isinstance(value["key"], str) and SAFE_NAME.fullmatch(value["key"]) is not None, f"{label}.key is invalid")
    command = _command(value["command"], f"{label}.command")
    require(command[0] == "docker", f"{label} must execute through Docker")
    require(isinstance(value["timeoutSeconds"], int) and 1 <= value["timeoutSeconds"] <= 1800,
            f"{label}.timeoutSeconds is invalid")
    return dict(value)


def _validate_reused_image(value: Any, component: str, label: str) -> dict[str, str]:
    fields = {"imageId", "parentEvidence", "parentEvidenceDigest"}
    require(isinstance(value, Mapping) and set(value) == fields, f"{label} fields drifted")
    image_id = value.get("imageId")
    require(isinstance(image_id, str) and SHA256.fullmatch(image_id) is not None,
            f"{label}.imageId is invalid")
    parent_value = value.get("parentEvidence")
    require(isinstance(parent_value, str) and parent_value.startswith("evidence/validation/"),
            f"{label}.parentEvidence is outside validation evidence")
    parent_pure = PurePosixPath(parent_value)
    require(not parent_pure.is_absolute() and ".." not in parent_pure.parts,
            f"{label}.parentEvidence is unsafe")
    parent = ROOT / parent_pure
    require(parent.is_file(), f"{label}.parentEvidence does not exist")
    parent_digest = value.get("parentEvidenceDigest")
    require(isinstance(parent_digest, str) and SHA256.fullmatch(parent_digest) is not None
            and parent_digest == digest_bytes(parent.read_bytes()),
            f"{label}.parentEvidenceDigest changed")
    try:
        evidence = json.loads(parent.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as error:
        raise FeatureDeploymentError(f"{label}.parentEvidence is invalid") from error
    bindings = evidence.get("imageBindings")
    binding = next((item for item in bindings if isinstance(item, Mapping)
                    and item.get("component") == component and item.get("imageId") == image_id), None) \
        if isinstance(bindings, list) else None
    require(binding is not None and binding.get("platform") == "linux/arm64/v8",
            f"{label} is not bound to the declared ARM64 component")
    steps = evidence.get("steps")
    require(isinstance(steps, list) and any(isinstance(item, Mapping)
            and item.get("key") in {f"build-{component}", f"reuse-{component}"}
            and item.get("passed") is True for item in steps),
            f"{label} parent did not materialize the declared component")
    return dict(value)


def validate_plan(value: Mapping[str, Any], policy: Mapping[str, Any] | None = None) -> dict[str, Any]:
    policy = policy or load_policy()
    required = set(policy["requiredPlanFields"])
    require(set(value) == required, "feature deployment plan fields drifted")
    require(value.get("schemaVersion") == 1, "feature deployment plan version drifted")
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    feature_map = {item["key"]: item for item in catalog["features"]}
    feature_key = value.get("featureKey")
    require(feature_key in feature_map, "feature deployment plan names an unknown feature")
    run_id = value.get("runId")
    require(isinstance(run_id, str) and SAFE_RUN_ID.fullmatch(run_id) is not None, "feature deployment run ID is unsafe")
    require(value.get("target") in policy["allowedTargets"], "feature deployment target is not allowlisted")

    source_prefixes = policy["allowedSourcePrefixes"]
    sources = value.get("sourcePaths")
    require(isinstance(sources, list) and sources, "feature deployment sourcePaths are missing")
    require(len(sources) == len(set(sources)), "feature deployment sourcePaths are duplicated")
    for index, source in enumerate(sources):
        _safe_relative(source, f"sourcePaths[{index}]", source_prefixes)
    compose_files = value.get("composeFiles")
    require(isinstance(compose_files, list) and compose_files, "feature deployment composeFiles are missing")
    require(len(compose_files) == len(set(compose_files)), "feature deployment composeFiles are duplicated")
    for index, compose in enumerate(compose_files):
        path = _safe_relative(compose, f"composeFiles[{index}]", ["deploy/"])
        require(path.suffix in {".yaml", ".yml"}, f"composeFiles[{index}] is not Compose YAML")
    environment_file = _safe_relative(value.get("environmentFile"), "environmentFile", ["deploy/"])
    require(environment_file.suffix == ".env", "environmentFile must be a committed non-secret .env file")

    environment = value.get("environment")
    require(isinstance(environment, Mapping), "feature deployment environment must be an object")
    for key, item in environment.items():
        require(isinstance(key, str) and SAFE_ENV.fullmatch(key) is not None and SENSITIVE_ENV.search(key) is None,
                f"feature deployment environment key is invalid or sensitive: {key}")
        require(isinstance(item, str) and len(item) <= 1024 and "\0" not in item and "\n" not in item,
                f"feature deployment environment value is invalid: {key}")
    secrets = value.get("secrets")
    require(isinstance(secrets, Mapping), "feature deployment secrets must be an object")
    for key, item in secrets.items():
        require(isinstance(key, str) and SAFE_ENV.fullmatch(key) is not None and SENSITIVE_ENV.search(key) is not None,
                f"feature deployment secret key must be explicitly sensitive: {key}")
        require(isinstance(item, str) and item.startswith("/run/secrets/") and ".." not in PurePosixPath(item).parts,
                f"feature deployment secret must be a remote secret-file reference: {key}")

    images = value.get("images")
    require(isinstance(images, list) and images, "feature deployment images are missing")
    components: set[str] = set()
    for index, image in enumerate(images):
        base_fields = {"component", "dockerfile", "context", "buildTag", "environmentKey"}
        allowed_fields = {frozenset(base_fields), frozenset(base_fields | {"reuse"}), frozenset(base_fields | {"buildArgs"})}
        require(isinstance(image, Mapping) and frozenset(image) in allowed_fields,
                f"images[{index}] fields drifted")
        component = image["component"]
        require(isinstance(component, str) and SAFE_NAME.fullmatch(component) is not None and component not in components,
                f"images[{index}].component is invalid or duplicated")
        components.add(component)
        dockerfile = _safe_relative(image["dockerfile"], f"images[{index}].dockerfile", ["deploy/"])
        require(dockerfile.name.endswith("Dockerfile"), f"images[{index}].dockerfile is invalid")
        context_value = image["context"]
        if context_value == ".":
            context = ROOT
        else:
            context = _safe_relative(context_value, f"images[{index}].context", source_prefixes)
        require(context.is_dir(), f"images[{index}].context is not a directory")
        require(isinstance(image["buildTag"], str)
                and re.fullmatch(r"[a-z0-9./_-]+:[a-z0-9][a-z0-9._-]{1,127}", image["buildTag"]) is not None
                and run_id in image["buildTag"] and not image["buildTag"].endswith(":latest"),
                f"images[{index}].buildTag is not run-scoped")
        require(isinstance(image["environmentKey"], str) and SAFE_ENV.fullmatch(image["environmentKey"]) is not None
                and image["environmentKey"].endswith("_IMAGE"), f"images[{index}].environmentKey is invalid")
        if "reuse" in image:
            _validate_reused_image(image["reuse"], component, f"images[{index}].reuse")
        if "buildArgs" in image:
            build_args = image["buildArgs"]
            require(isinstance(build_args, Mapping) and 1 <= len(build_args) <= 16,
                    f"images[{index}].buildArgs is invalid")
            for key, item in build_args.items():
                require(isinstance(key, str) and SAFE_ENV.fullmatch(key) is not None
                        and SENSITIVE_ENV.search(key) is None,
                        f"images[{index}].buildArgs key is invalid or sensitive")
                require(isinstance(item, str) and 1 <= len(item) <= 1024
                        and "\0" not in item and "\n" not in item,
                        f"images[{index}].buildArgs value is invalid")

    for field in ("dependencyServices", "featureServices"):
        services = value.get(field)
        require(isinstance(services, list) and services, f"{field} are missing")
        require(all(isinstance(item, str) and SAFE_NAME.fullmatch(item) is not None for item in services),
                f"{field} contains an invalid service")
        require(len(services) == len(set(services)), f"{field} contains duplicates")
    require(not set(value["dependencyServices"]) & set(value["featureServices"]),
            "dependencyServices and featureServices overlap")

    migrations = value.get("migrations")
    require(isinstance(migrations, Mapping) and set(migrations) == {"command", "timeoutSeconds", "expected"},
            "migration declaration fields drifted")
    migration_command = _command(migrations["command"], "migrations.command")
    require(migration_command[:2] == ["docker", "compose"], "migrations must run in a Compose container")
    require(isinstance(migrations["timeoutSeconds"], int) and 1 <= migrations["timeoutSeconds"] <= 1800,
            "migration timeout is invalid")
    require(migrations["expected"] == feature_map[feature_key]["migrations"],
            "migration expectation does not match the feature catalog")
    health = value.get("healthChecks")
    retained = value.get("retainedStateChecks")
    require(isinstance(health, list) and health, "health checks are missing")
    require(isinstance(retained, list) and retained, "retained-state checks are missing")
    [_check_declaration(item, f"healthChecks[{index}]") for index, item in enumerate(health)]
    [_check_declaration(item, f"retainedStateChecks[{index}]") for index, item in enumerate(retained)]
    rollback = value.get("rollback")
    require(isinstance(rollback, Mapping) and set(rollback) == {"command", "timeoutSeconds"}, "rollback fields drifted")
    rollback_command = _command(rollback["command"], "rollback.command")
    require(rollback_command[:2] == ["docker", "compose"], "rollback must use the exact Compose project")
    require(isinstance(rollback["timeoutSeconds"], int) and 1 <= rollback["timeoutSeconds"] <= 1800,
            "rollback timeout is invalid")
    return dict(value)


def source_files(paths: Sequence[str]) -> list[Path]:
    selected: set[Path] = set()
    root = ROOT.resolve()
    for value in paths:
        path = (ROOT / value).resolve()
        candidates = [path] if path.is_file() else [item for item in path.rglob("*") if item.is_file()]
        for item in candidates:
            relative = item.relative_to(root)
            if item.is_symlink() or any(part in SOURCE_EXCLUSIONS for part in relative.parts):
                continue
            selected.add(item)
    return sorted(selected)


def archive_source(paths: Sequence[str], destination: Path) -> tuple[str, int]:
    files = source_files(paths)
    require(files, "feature deployment source archive would be empty")
    digest = hashlib.sha256()
    with tarfile.open(destination, "w:gz", format=tarfile.PAX_FORMAT) as archive:
        for path in files:
            relative = path.relative_to(ROOT).as_posix()
            payload = path.read_bytes()
            digest.update(relative.encode() + b"\0" + hashlib.sha256(payload).digest())
            archive.add(path, arcname=relative, recursive=False)
    return "sha256:" + digest.hexdigest(), len(files)


def required(result: CommandResult, step: str) -> CommandResult:
    if result.returncode != 0:
        output = (result.stderr or result.stdout).strip().splitlines()
        detail = re.sub(r"(?i)(password|token|secret|credential)=\S+", r"\1=[REDACTED]", output[-1] if output else "no output")
        raise FeatureDeploymentError(f"{step} failed: {detail[:300]}")
    return result


def remote_command(command: Sequence[str], staging: str, project: str, compose_files: Sequence[str], environment_file: str) -> list[str]:
    values = [item.replace("{staging}", staging).replace("{project}", project) for item in command]
    compose = ["docker", "compose", "--project-name", project,
               "--env-file", f"{staging}/source/{environment_file}",
               "--env-file", f"{staging}/runtime.env"]
    for path in compose_files:
        compose.extend(["--file", f"{staging}/source/{path}"])
    compose.extend(["--project-directory", f"{staging}/source"])
    if values[:2] == ["docker", "compose"]:
        return [*compose, *values[2:]]
    return values


def write_runtime_environment(plan: Mapping[str, Any], image_ids: Mapping[str, str], destination: Path) -> str:
    values = dict(plan["environment"])
    values.update(plan["secrets"])
    for image in plan["images"]:
        values[image["environmentKey"]] = image_ids[image["component"]]
    payload = "".join(f"{key}={values[key]}\n" for key in sorted(values))
    destination.write_text(payload, encoding="utf-8")
    return digest_bytes(payload.encode())


def run_step(remote: Remote, command: Sequence[str], timeout: int, key: str) -> dict[str, Any]:
    started = time.monotonic()
    result = remote.run(command, timeout)
    evidence = {
        "key": key,
        "passed": result.returncode == 0,
        "durationMilliseconds": round((time.monotonic() - started) * 1000),
        "commandDigest": digest_bytes(canonical_bytes(list(command))),
        "stdoutDigest": digest_bytes(result.stdout.encode()),
        "stderrDigest": digest_bytes(result.stderr.encode()),
        "returnCode": result.returncode,
        "outputRetained": False,
    }
    if result.returncode != 0:
        tail = (result.stderr or result.stdout).strip().splitlines()[-1:] or ["no output"]
        evidence["failureSummary"] = re.sub(
            r"(?i)(password|token|secret|credential|authorization|cookie)(\s*[:=]\s*)\S+",
            r"\1\2[REDACTED]",
            tail[0],
        )[:300]
    return evidence


def cleanup_stage(remote: Remote, staging: str) -> bool:
    result = remote.run(("rm", "-r", "--", staging), 60)
    residual = remote.run(("test", "!", "-e", staging), 10)
    return result.returncode in {0, 1} and residual.returncode == 0


def cleanup_deployment_root(remote: Remote, deployment_root: str) -> bool:
    require(deployment_root.startswith("/var/lib/teamaibox-feature-deployments/")
            and deployment_root.count("/") == 4,
            "deployment root cleanup target is unsafe")
    result = remote.run(("sudo", "--non-interactive", "rm", "-r", "--", deployment_root), 60)
    residual = remote.run(("test", "!", "-e", deployment_root), 10)
    return result.returncode in {0, 1} and residual.returncode == 0


def execute_plan(
    plan: Mapping[str, Any],
    *,
    remote: Remote | None = None,
    evidence_path: Path | None = None,
) -> dict[str, Any]:
    policy = load_policy()
    plan = validate_plan(plan, policy)
    target = policy["allowedTargets"][plan["target"]]
    remote = remote or RemoteSpark(target["ssh"])
    run_id = plan["runId"]
    staging = policy["remoteStagingPrefix"] + run_id
    deployment_root = policy["remoteDeploymentPrefix"] + run_id
    project = policy["composeProjectPrefix"] + re.sub(r"[^a-z0-9]", "_", run_id)
    output = evidence_path or EVIDENCE_ROOT / f"{run_id}.json"
    require(output.is_absolute() and (output == ROOT or ROOT in output.parents), "deployment evidence must remain in the repository")
    require(not output.exists(), "deployment evidence already exists; use a new run ID")
    started_at = iso_now()
    steps: list[dict[str, Any]] = []
    source_digest: str | None = None
    source_count = 0
    image_bindings: list[dict[str, Any]] = []
    runtime_environment_digest: str | None = None
    rollback_attempted = False
    rollback_passed = False
    cleanup_passed = False
    deployment_root_cleanup_passed = False
    deployment_material_check_passed = False
    status = "failed"
    failure: dict[str, Any] | None = None
    try:
        with tempfile.TemporaryDirectory(prefix="teamaibox-feature-") as directory:
            archive = Path(directory) / "source.tar.gz"
            source_digest, source_count = archive_source(plan["sourcePaths"], archive)
            require(remote.run(("test", "!", "-e", staging), 10).returncode == 0,
                    "remote staging path already exists")
            require(remote.run(("test", "!", "-e", deployment_root), 10).returncode == 0,
                    "remote deployment root already exists")
            required(remote.run(("mkdir", "--", staging), 15), "remote staging create")
            required(remote.copy(archive, staging + "/source.tar.gz", 180), "remote staging copy")
            required(remote.run(("sudo", "--non-interactive", "install", "--directory", "--mode=0750",
                                 "--owner", target["deploymentOwner"], "--group", target["deploymentOwner"], "--", deployment_root), 30),
                     "durable deployment root create")
            required(remote.run(("mkdir", "--", deployment_root + "/source"), 15), "remote source create")
            required(remote.run(("tar", "-xzf", staging + "/source.tar.gz", "-C", deployment_root + "/source"), 120), "remote source extract")
            initial_images = {image["component"]: image["buildTag"] for image in plan["images"]}
            runtime_environment = Path(directory) / "runtime.env"
            runtime_environment_digest = write_runtime_environment(plan, initial_images, runtime_environment)
            required(remote.copy(runtime_environment, deployment_root + "/runtime.env", 60), "initial runtime environment copy")
        identity = run_step(remote, ("docker", "version", "--format", "{{.Server.Arch}}"), 20, "verify-target")
        steps.append(identity)
        require(identity["passed"], "target Docker identity failed")
        arch = required(remote.run(("docker", "version", "--format", "{{.Server.Arch}}"), 20), "target architecture").stdout.strip()
        require(arch in {"arm64", "aarch64"}, "target Docker architecture is not ARM64")

        image_ids: dict[str, str] = {}
        for image in plan["images"]:
            if "reuse" in image:
                expected_id = image["reuse"]["imageId"]
                source = required(remote.run(("docker", "image", "inspect", "--format", "{{.Architecture}} {{.Id}}", expected_id), 30),
                                  f"reused image source verification {image['component']}").stdout.strip().split(maxsplit=1)
                require(len(source) == 2 and source[0] == "arm64" and source[1] == expected_id,
                        f"reused image source identity drifted: {image['component']}")
                command = ("docker", "image", "tag", expected_id, image["buildTag"])
                step_key = f"reuse-{image['component']}"
            else:
                command = [
                    "docker", "buildx", "build", "--platform", "linux/arm64/v8", "--network", "host", "--pull=false", "--load",
                    "--label", "com.teamaibox.managed=true", "--label", f"com.teamaibox.feature={plan['featureKey']}",
                    "--label", f"com.teamaibox.run-id={run_id}", "--file", f"{deployment_root}/source/{image['dockerfile']}",
                ]
                for key, item in sorted(image.get("buildArgs", {}).items()):
                    command.extend(["--build-arg", f"{key}={item}"])
                command.extend(["--tag", image["buildTag"], f"{deployment_root}/source/{image['context']}"])
                step_key = f"build-{image['component']}"
            result = run_step(remote, command, 1800, step_key)
            steps.append(result)
            require(result["passed"], f"image materialization failed: {image['component']}")
            inspect = required(remote.run(("docker", "image", "inspect", "--format", "{{.Architecture}} {{.Id}}", image["buildTag"]), 30),
                               f"image verification {image['component']}").stdout.strip().split(maxsplit=1)
            require(len(inspect) == 2 and inspect[0] == "arm64" and SHA256.fullmatch(inspect[1]) is not None,
                    f"built image identity drifted: {image['component']}")
            if "reuse" in image:
                require(inspect[1] == image["reuse"]["imageId"],
                        f"reused image tag identity drifted: {image['component']}")
            image_ids[image["component"]] = inspect[1]
            image_bindings.append({"component": image["component"], "buildTag": image["buildTag"],
                                   "imageId": inspect[1], "platform": "linux/arm64/v8"})

        with tempfile.TemporaryDirectory(prefix="teamaibox-feature-env-") as directory:
            runtime_environment = Path(directory) / "runtime.env"
            runtime_environment_digest = write_runtime_environment(plan, image_ids, runtime_environment)
            required(remote.copy(runtime_environment, deployment_root + "/runtime.env", 60), "runtime environment copy")

        compose_base = ["docker", "compose", "--project-name", project,
                        "--env-file", f"{deployment_root}/source/{plan['environmentFile']}",
                        "--env-file", f"{deployment_root}/runtime.env"]
        for path in plan["composeFiles"]:
            compose_base.extend(["--file", f"{deployment_root}/source/{path}"])
        compose_base.extend(["--project-directory", f"{deployment_root}/source"])
        render = run_step(remote, [*compose_base, "config", "--quiet"], 120, "render-compose")
        steps.append(render)
        require(render["passed"], "Compose render failed")
        dependencies = run_step(remote, [*compose_base, "up", "--detach", "--wait", *plan["dependencyServices"]], 600, "deploy-dependencies")
        steps.append(dependencies)
        require(dependencies["passed"], "persistent dependencies failed")
        migration_command = remote_command(plan["migrations"]["command"], deployment_root, project, plan["composeFiles"], plan["environmentFile"])
        migration = run_step(remote, migration_command, plan["migrations"]["timeoutSeconds"], "migrate")
        steps.append(migration)
        require(migration["passed"], "migration failed")
        deployment = run_step(remote, [*compose_base, "up", "--detach", "--wait", "--remove-orphans", *plan["featureServices"]], 900, "deploy-feature")
        steps.append(deployment)
        require(deployment["passed"], "feature deployment failed")
        for declaration in plan["healthChecks"]:
            command = remote_command(declaration["command"], deployment_root, project, plan["composeFiles"], plan["environmentFile"])
            result = run_step(remote, command, declaration["timeoutSeconds"], f"health-{declaration['key']}")
            steps.append(result)
            require(result["passed"], f"health check failed: {declaration['key']}")
        for declaration in plan["retainedStateChecks"]:
            command = remote_command(declaration["command"], deployment_root, project, plan["composeFiles"], plan["environmentFile"])
            result = run_step(remote, command, declaration["timeoutSeconds"], f"retained-{declaration['key']}")
            steps.append(result)
            require(result["passed"], f"retained-state check failed: {declaration['key']}")
        replay = run_step(remote, [*compose_base, "up", "--detach", "--wait", "--remove-orphans",
                                           *plan["dependencyServices"], *plan["featureServices"]], 900, "idempotent-replay")
        steps.append(replay)
        require(replay["passed"], "idempotent deployment replay failed")
        residual = required(remote.run(("docker", "ps", "--all", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Label \"com.docker.compose.project\"}}"), 30),
                            "residual project inspection")
        require(all(line == project for line in residual.stdout.splitlines()), "unexpected residual project resources were found")
        steps.append({"key":"residual-check","passed":True,"durationMilliseconds":0,"commandDigest":digest_bytes(b"residual-project-inspection"),
                      "stdoutDigest":digest_bytes(residual.stdout.encode()),"stderrDigest":digest_bytes(residual.stderr.encode()),"returnCode":0,"outputRetained":False})
        cleanup_passed = cleanup_stage(remote, staging)
        require(cleanup_passed, "temporary build staging cleanup failed")
        material = run_step(remote, ("test", "-d", deployment_root + "/source", "-a", "-f", deployment_root + "/runtime.env"),
                            10, "durable-deployment-material")
        steps.append(material)
        require(material["passed"], "durable deployment material is unavailable")
        containers = required(remote.run(("docker", "ps", "--all", "--filter",
                                          f"label=com.docker.compose.project={project}", "--format", "{{.Names}}"), 30),
                              "durable container inventory")
        container_names = [line for line in containers.stdout.splitlines() if line]
        require(container_names, "durable deployment has no retained containers")
        mounts = required(remote.run(("docker", "inspect", "--format", "{{range .Mounts}}{{println .Source}}{{end}}",
                                      *container_names), 60), "durable bind-source inspection")
        require(not any(path.startswith(policy["remoteStagingPrefix"]) for path in mounts.stdout.splitlines()),
                "retained containers depend on temporary staging")
        deployment_material_check_passed = True
        status = "passed"
    except (FeatureDeploymentError, SparkValidationError) as error:
        failure = {"type": type(error).__name__, "message": str(error)[:500]}
        rollback_attempted = True
        rollback_command = remote_command(plan["rollback"]["command"], deployment_root, project, plan["composeFiles"], plan["environmentFile"])
        rollback_result = run_step(remote, rollback_command, plan["rollback"]["timeoutSeconds"], "rollback")
        steps.append(rollback_result)
        rollback_passed = rollback_result["passed"]
        if rollback_passed:
            residual = remote.run(("docker", "ps", "--all", "--filter", f"label=com.docker.compose.project={project}", "--quiet"), 30)
            rollback_passed = residual.returncode == 0 and not residual.stdout.strip()
    finally:
        if not cleanup_passed:
            cleanup_passed = cleanup_stage(remote, staging)
        if status != "passed":
            deployment_root_cleanup_passed = cleanup_deployment_root(remote, deployment_root)

    evidence = {
        "schemaVersion": 2,
        "runnerId": policy["runnerId"],
        "runId": run_id,
        "featureKey": plan["featureKey"],
        "status": status,
        "startedAt": started_at,
        "completedAt": iso_now(),
        "target": plan["target"],
        "architecture": "linux/arm64/v8",
        "composeProject": project,
        "sourceDigest": source_digest,
        "sourceFileCount": source_count,
        "planDigest": digest_bytes(canonical_bytes(plan)),
        "policyDigest": digest_bytes(POLICY.read_bytes()),
        "runnerDigest": digest_bytes(Path(__file__).read_bytes()),
        "catalogDigest": digest_bytes(CATALOG.read_bytes()),
        "runtimeEnvironmentDigest": runtime_environment_digest,
        "imageBindings": image_bindings,
        "migrationNames": plan["migrations"]["expected"],
        "steps": steps,
        "idempotentReplayPassed": any(item["key"] == "idempotent-replay" and item["passed"] for item in steps),
        "rollbackAttempted": rollback_attempted,
        "rollbackPassed": rollback_passed,
        "stagingCleanupPassed": cleanup_passed,
        "deploymentRoot": deployment_root,
        "deploymentRootRetained": status == "passed" and not deployment_root_cleanup_passed,
        "deploymentMaterialCheckPassed": deployment_material_check_passed,
        "failure": failure,
        "credentialsRetained": False,
        "commandOutputRetained": False,
    }
    evidence["evidenceDigest"] = digest_bytes(canonical_bytes(evidence))
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_bytes(json.dumps(evidence, indent=2, sort_keys=True).encode() + b"\n")
    os.replace(temporary, output)
    if status != "passed":
        raise FeatureDeploymentError(f"feature deployment failed; evidence: {output.relative_to(ROOT).as_posix()}")
    return {**evidence, "evidence": output.relative_to(ROOT).as_posix()}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--evidence", type=Path)
    args = parser.parse_args(argv)
    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    result = execute_plan(plan, evidence_path=args.evidence.resolve() if args.evidence else None)
    print(json.dumps({key: result[key] for key in ("runId", "featureKey", "status", "evidence")}, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FeatureDeploymentError, SparkValidationError, json.JSONDecodeError, OSError) as error:
        print(f"feature ARM64 deployment failed: {error}")
        raise SystemExit(1)
