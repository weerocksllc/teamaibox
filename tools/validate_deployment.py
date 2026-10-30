#!/usr/bin/env python3
"""Validate image locks, core service classes, and rendered Compose manifests."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess
from typing import Any, Mapping, Sequence


ROOT = pathlib.Path(__file__).resolve().parents[1]
IMAGE_LOCK = ROOT / "deploy" / "compose" / "images.arm64.json"
RESOURCE_POLICY = ROOT / "deploy" / "compose" / "resource-policy.json"
CORE_COMPOSE = ROOT / "deploy" / "compose" / "core.yaml"
DEVELOPMENT_COMPOSE = ROOT / "deploy" / "development" / "compose.yaml"
APPLIANCE_COMPOSE = ROOT / "deploy" / "appliance" / "compose.yaml"
IMAGES_ENV = ROOT / "deploy" / "compose" / "images.arm64.env"
BUILT_IN_APPLICATIONS = ROOT / "deploy" / "applications" / "built-in-applications.v1.json"

DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
DIGEST_REFERENCE = re.compile(r"^[^@\s]+@sha256:[0-9a-f]{64}$")
REQUIRED_IMAGES = {"node-runtime", "postgres", "nats"}
RUNTIME_SERVICES = {
    "agent-bridge",
    "compute-gateway",
    "event-bus",
    "messaging",
    "node-agent",
    "object-service",
    "platform-api",
    "plugin-runtime",
    "postgres",
    "scheduler",
    "source-gateway",
    "web",
    "observability",
}
ONE_SHOT_SERVICES = {"database-migrate"}
REQUIRED_SERVICES = RUNTIME_SERVICES | ONE_SHOT_SERVICES
PRODUCTION_IMAGE_VARIABLES = {
    "TEAMAIBOX_WEB_IMAGE": "web",
    "TEAMAIBOX_PLATFORM_API_IMAGE": "platform-api",
    "TEAMAIBOX_POSTGRES_IMAGE": "postgres",
    "TEAMAIBOX_EVENT_BUS_IMAGE": "event-bus",
    "TEAMAIBOX_OBJECT_SERVICE_IMAGE": "object-service",
    "TEAMAIBOX_SCHEDULER_IMAGE": "scheduler",
    "TEAMAIBOX_NODE_AGENT_IMAGE": "node-agent",
    "TEAMAIBOX_PLUGIN_RUNTIME_IMAGE": "plugin-runtime",
    "TEAMAIBOX_AGENT_BRIDGE_IMAGE": "agent-bridge",
    "TEAMAIBOX_COMPUTE_GATEWAY_IMAGE": "compute-gateway",
    "TEAMAIBOX_MESSAGING_IMAGE": "messaging",
    "TEAMAIBOX_SOURCE_GATEWAY_IMAGE": "source-gateway",
    "TEAMAIBOX_OBSERVABILITY_IMAGE": "observability",
}
REQUIRED_VOLUMES = {
    "agent_bridge_data", "agent_workspace_data", "agent_cache", "audit_data", "backup_staging",
    "compute_worker_data", "diagnostics_data", "event_bus_data", "model_artifacts", "model_cache",
    "model_evidence", "node_agent_identity", "node_agent_state", "object_data", "object_staging",
    "observability_data", "plugin_cache", "plugin_data", "postgres_data", "secrets_data", "source_cache",
}
REQUIRED_SURVIVAL_DOMAINS = {
    "identity", "administration", "files", "messaging",
    "database", "object", "queue",
}


class DeploymentError(ValueError):
    pass


def validate_docker_socket_mount(service_name: str, mount: Any) -> bool:
    """Allow the Docker control socket only at the explicit Node Agent boundary."""
    if isinstance(mount, Mapping):
        source = mount.get("source")
        target = mount.get("target")
        read_only = mount.get("read_only") is True
    else:
        parts = str(mount).split(":")
        source = parts[0]
        target = parts[1] if len(parts) > 1 else None
        read_only = len(parts) > 2 and "ro" in parts[2].split(",")
    if source not in {"/var/run/docker.sock", "/run/docker.sock"}:
        return False
    if service_name != "node-agent":
        raise DeploymentError(f"{service_name} unexpectedly mounts the Docker socket")
    if target != "/var/run/docker.sock" or not read_only:
        raise DeploymentError("node-agent Docker socket must use the exact read-only mount target")
    return True


def _load_json(path: pathlib.Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise DeploymentError(f"{path.name} must contain a JSON object")
    return value


def validate_image_lock(lock: Mapping[str, Any]) -> None:
    if lock.get("schemaVersion") != 1 or lock.get("architecture") != "linux/arm64/v8":
        raise DeploymentError("image lock must be schema 1 for linux/arm64/v8")
    images = lock.get("images")
    if not isinstance(images, Mapping) or set(images) != REQUIRED_IMAGES:
        raise DeploymentError("image lock must contain exactly the required foundation images")
    for name, item in images.items():
        if not isinstance(item, Mapping):
            raise DeploymentError(f"{name} image lock must be an object")
        tag = item.get("sourceTag")
        index_digest = item.get("indexDigest")
        arm64_digest = item.get("arm64Digest")
        reference = item.get("reference")
        if not isinstance(tag, str) or tag.endswith(":latest") or ":" not in tag.rsplit("/", 1)[-1]:
            raise DeploymentError(f"{name} must record a version-specific source tag")
        if not isinstance(index_digest, str) or not DIGEST.fullmatch(index_digest):
            raise DeploymentError(f"{name} has an invalid index digest")
        if not isinstance(arm64_digest, str) or not DIGEST.fullmatch(arm64_digest):
            raise DeploymentError(f"{name} has an invalid ARM64 digest")
        if not isinstance(reference, str) or not DIGEST_REFERENCE.fullmatch(reference):
            raise DeploymentError(f"{name} reference is not digest pinned")
        if not reference.endswith("@" + arm64_digest):
            raise DeploymentError(f"{name} reference does not use its ARM64 digest")


def validate_resource_policy(policy: Mapping[str, Any]) -> None:
    if policy.get("schemaVersion") != 1:
        raise DeploymentError("resource policy schemaVersion must be 1")
    classes = policy.get("resourceClasses")
    survival = policy.get("serviceSurvivalDomains")
    if not isinstance(classes, Mapping) or set(classes) != {"core-critical", "core-standard"}:
        raise DeploymentError("core-critical and core-standard resource classes are required")
    if not isinstance(survival, Mapping) or set(survival) != REQUIRED_SURVIVAL_DOMAINS:
        raise DeploymentError("all seven core-service survival domains are required")
    classified: list[str] = []
    for resource_class, definition in classes.items():
        if not isinstance(definition, Mapping) or not isinstance(definition.get("services"), list):
            raise DeploymentError(f"{resource_class} must list services")
        classified.extend(definition["services"])
    if len(classified) != len(set(classified)):
        raise DeploymentError("a service cannot belong to multiple resource classes")
    if set(classified) != RUNTIME_SERVICES:
        raise DeploymentError("every and only required core service must be classified")
    for domain, definition in survival.items():
        services = definition.get("services") if isinstance(definition, Mapping) else None
        if not isinstance(services, list) or not services or any(service not in RUNTIME_SERVICES for service in services):
            raise DeploymentError(f"survival domain {domain} must reference core services only")


def validate_rendered_compose(rendered: Mapping[str, Any], appliance: bool) -> None:
    services = rendered.get("services")
    networks = rendered.get("networks")
    volumes = rendered.get("volumes")
    expected_services = REQUIRED_SERVICES | ({"appliance-gateway"} if appliance else set())
    if not isinstance(services, Mapping) or set(services) != expected_services:
        raise DeploymentError("rendered Compose services do not match the foundation set")
    if not isinstance(networks, Mapping) or not {"edge", "control", "data"}.issubset(networks):
        raise DeploymentError("edge, control, and data networks are required")
    for internal_name in ("control", "data"):
        if networks[internal_name].get("internal") is not True:
            raise DeploymentError(f"{internal_name} network must be internal")
    if not isinstance(volumes, Mapping) or not REQUIRED_VOLUMES.issubset(volumes):
        raise DeploymentError("required persistent volumes are missing")

    configs = rendered.get("configs")
    if not isinstance(configs, Mapping) or "foundation_service" in configs:
        raise DeploymentError("foundation stub configuration is forbidden")
    secrets = rendered.get("secrets")
    required_secrets = {
        "postgres_password", "nats_token", "platform_audit_signing_key", "agent_model_signing_key", "node_agent_command_key",
    }
    if appliance:
        local_agent = services["node-agent"]
        local_gateway = services["appliance-gateway"]
        if any(service.get("network_mode") != "service:platform-api" or service.get("ports")
               for service in (local_agent, local_gateway)):
            raise DeploymentError("appliance control services must share the API loopback namespace without published ports")
        if local_agent.get("environment", {}).get("TEAMAIBOX_LISTEN_ADDRESS") != "127.0.0.1:9443" \
                or services["platform-api"].get("environment", {}).get("PLATFORM_APPLIANCE_AGENT_HOST") != "127.0.0.1":
            raise DeploymentError("appliance control must use the local loopback interface")
        required_secrets |= {"web_tls_certificate", "web_tls_private_key"}
    if not isinstance(secrets, Mapping) or not required_secrets.issubset(secrets):
        raise DeploymentError("supported deployment secrets are incomplete")

    for name, service in services.items():
        image = service.get("image")
        if not isinstance(image, str) or not DIGEST_REFERENCE.fullmatch(image):
            raise DeploymentError(f"{name} image is not digest pinned")
        if service.get("platform") != "linux/arm64/v8":
            raise DeploymentError(f"{name} is not locked to linux/arm64/v8")
        if name in RUNTIME_SERVICES and service.get("healthcheck") in (None, {}, {"disable": True}):
            raise DeploymentError(f"{name} has no enabled health check")
        if service.get("read_only") is not True:
            raise DeploymentError(f"{name} root filesystem is not read-only")
        if service.get("privileged") is True:
            raise DeploymentError(f"{name} must not be privileged")
        labels = service.get("labels")
        if not isinstance(labels, Mapping) or labels.get("com.teamaibox.resource-class") not in {
            "core-critical",
            "core-standard",
        }:
            raise DeploymentError(f"{name} has no core resource-class label")
        if labels.get("com.teamaibox.foundation-stub") is not None:
            raise DeploymentError(f"{name} still declares a foundation stub")
        if not service.get("mem_limit") or not service.get("cpus"):
            raise DeploymentError(f"{name} lacks memory/CPU limits")
        user = str(service.get("user", ""))
        if user in {"", "0", "0:0", "root", "root:root"}:
            raise DeploymentError(f"{name} does not declare a non-root runtime user")
        serialized = json.dumps(service, sort_keys=True)
        if "foundation-service.mjs" in serialized or "foundationStub" in serialized:
            raise DeploymentError(f"{name} contains a demo foundation fallback")
        for mount in service.get("volumes", []):
            validate_docker_socket_mount(name, mount)

    migration = services["database-migrate"]
    if migration.get("image") != services["postgres"].get("image"):
        raise DeploymentError("database migration must reuse the exact PostgreSQL release image")
    if migration.get("entrypoint") != ["/usr/local/bin/teamaibox-apply-migrations"] \
            or str(migration.get("restart")) != "no":
        raise DeploymentError("database migration must be an exact fail-closed one-shot")
    migration_dependencies = migration.get("depends_on")
    if not isinstance(migration_dependencies, Mapping) \
            or migration_dependencies.get("postgres", {}).get("condition") != "service_healthy":
        raise DeploymentError("database migration must wait for healthy PostgreSQL")
    for name in {
        "platform-api", "object-service", "messaging", "scheduler", "plugin-runtime",
        "agent-bridge", "source-gateway", "observability",
    }:
        dependencies = services[name].get("depends_on")
        if not isinstance(dependencies, Mapping) \
                or dependencies.get("database-migrate", {}).get("condition") != "service_completed_successfully":
            raise DeploymentError(f"{name} does not wait for successful migrations")
    platform_environment = services["platform-api"].get("environment")
    if not isinstance(platform_environment, Mapping) \
            or platform_environment.get("PLATFORM_API_PERSISTENCE") != "postgres" \
            or platform_environment.get("PLATFORM_DATABASE_TLS_MODE") != "disable" \
            or "PLATFORM_DATABASE_URL" in platform_environment \
            or "DATABASE_URL" in platform_environment:
        raise DeploymentError("platform API must use explicit PostgreSQL settings without a memory/URL fallback")
    if platform_environment.get("PLATFORM_APPLICATION_ROUTES_FILE") != "/run/config/plugin-routes.json" \
            or platform_environment.get("PLATFORM_BUILT_IN_APPLICATIONS_FILE") != "/run/config/built-in-applications.json" \
            or platform_environment.get("PLATFORM_AGENT_MODEL_SIGNING_KEY_FILE") != "/run/secrets/agent_model_signing_key" \
            or platform_environment.get("PLATFORM_AGENT_MODEL_ALIAS_MAP_FILE") != "/run/config/agent-model-aliases.json":
        raise DeploymentError("platform API application facts are not bound to release configuration")
    platform_configs = services["platform-api"].get("configs")
    if not isinstance(platform_configs, list) or {
        (item.get("source"), item.get("target")) for item in platform_configs if isinstance(item, Mapping)
    } != {
        ("empty_plugin_routes", "/run/config/plugin-routes.json"),
        ("built_in_applications", "/run/config/built-in-applications.json"),
    }:
        raise DeploymentError("platform API mutable application manifests are not mounted exactly")
    gateway = services["compute-gateway"]
    gateway_environment = gateway.get("environment")
    if not isinstance(gateway_environment, Mapping) \
            or gateway_environment.get("PLATFORM_COMPUTE_ORIGIN") != "http://platform-api:8080" \
            or gateway_environment.get("AGENT_MODEL_SIGNING_KEY_FILE") != "/run/secrets/agent_model_signing_key" \
            or gateway_environment.get("AGENT_MODEL_ALIAS_MAP_FILE") != "/run/config/agent-model-aliases.json":
        raise DeploymentError("Agent Compute Gateway trust boundary is not configured exactly")
    gateway_networks = gateway.get("networks")
    if not isinstance(gateway_networks, Mapping) or set(gateway_networks) != {"control", "agent-egress-proxy"}:
        raise DeploymentError("Agent Compute Gateway network boundary drifted")
    if any(isinstance(item, Mapping) and item.get("target") == "/run/config/agent-model-aliases.json"
           for item in gateway.get("configs", [])):
        raise DeploymentError("Agent model aliases must be immutable image content, not a host-backed config")
    platform_networks = services["platform-api"].get("networks")
    if isinstance(platform_networks, Mapping) and "agent-egress-proxy" in platform_networks:
        raise DeploymentError("Agent sandboxes must not bypass the Agent Compute Gateway")
    web_configs = services["web"].get("configs")
    if not isinstance(web_configs, list) or ("empty_plugin_routes", "/run/config/plugin-routes.json") not in {
        (item.get("source"), item.get("target")) for item in web_configs if isinstance(item, Mapping)
    }:
        raise DeploymentError("Web and platform API do not share the exact application route manifest")
    for name in {
        "object-service", "messaging", "scheduler", "plugin-runtime", "agent-bridge",
        "source-gateway", "observability",
    }:
        environment = services[name].get("environment")
        if not isinstance(environment, Mapping) or environment.get("TEAMAIBOX_SERVICE_NAME") != name:
            raise DeploymentError(f"{name} production runtime binding drifted")
        if environment.get("TEAMAIBOX_REQUIRED_SCHEMA_VERSION") != "105":
            raise DeploymentError(f"{name} schema gate drifted")
    node_agent_mounts = [
        mount for mount in services["node-agent"].get("volumes", [])
        if (mount.get("source") if isinstance(mount, Mapping) else str(mount).split(":", 1)[0])
        in {"/var/run/docker.sock", "/run/docker.sock"}
    ]
    if len(node_agent_mounts) != 1 or not services["node-agent"].get("group_add"):
        raise DeploymentError("node-agent must be the sole group-scoped Docker control boundary")

    web_environment = services["web"].get("environment")
    if not isinstance(web_environment, Mapping):
        raise DeploymentError("Web runtime environment is missing")

    if appliance:
        if services["platform-api"].get("ports"):
            raise DeploymentError("appliance platform API must remain internal")
        ports = services["web"].get("ports")
        if not isinstance(ports, list) or len(ports) != 1:
            raise DeploymentError("appliance Web boundary must publish exactly one HTTPS port")
        port = ports[0]
        if not isinstance(port, Mapping) or port.get("target") != 8443 \
                or port.get("host_ip") in {None, "127.0.0.1", "::1"}:
            raise DeploymentError("appliance Web boundary must publish the release HTTPS listener")
        if web_environment.get("WEB_MODE") != "release" \
                or web_environment.get("WEB_TLS_CERT_FILE") != "/run/secrets/web_tls_certificate" \
                or web_environment.get("WEB_TLS_KEY_FILE") != "/run/secrets/web_tls_private_key" \
                or not str(web_environment.get("WEB_PUBLIC_ORIGIN", "")).startswith("https://"):
            raise DeploymentError("appliance Web boundary is not fail-closed release HTTPS")
        for name in REQUIRED_VOLUMES:
            definition = volumes[name]
            options = definition.get("driver_opts") if isinstance(definition, Mapping) else None
            device = options.get("device") if isinstance(options, Mapping) else None
            if not isinstance(device, str) or not device.startswith("/"):
                raise DeploymentError(f"appliance volume {name} must bind an absolute data-root path")
    else:
        for exposed_name in ("platform-api", "web"):
            ports = services[exposed_name].get("ports")
            if not isinstance(ports, list) or not ports:
                raise DeploymentError(f"development {exposed_name} must expose a loopback port")
            for port in ports:
                if not isinstance(port, Mapping) or port.get("host_ip") != "127.0.0.1":
                    raise DeploymentError(f"development {exposed_name} port must bind loopback only")
        if web_environment.get("WEB_MODE") != "development" \
                or web_environment.get("WEB_ALLOW_INSECURE_HTTP") != "true" \
                or web_environment.get("WEB_DEVELOPMENT_DEMO") != "false":
            raise DeploymentError("development Web mode must be explicit, isolated, and demo-free")


def validation_render_environment() -> dict[str, str]:
    """Create non-deployable values used only to verify Compose structure."""
    environment = {
        variable: f"registry.validation.invalid/teamaibox/{component}@sha256:"
        + hashlib.sha256(variable.encode("utf-8")).hexdigest()
        for variable, component in PRODUCTION_IMAGE_VARIABLES.items()
    }
    environment.update({
        "TEAMAIBOX_APPLIANCE_GATEWAY_IMAGE": "registry.validation.invalid/teamaibox/appliance-gateway@sha256:" + "a" * 64,
        "PLATFORM_APPLIANCE_NODE_ID": "11111111-1111-4111-8111-111111111111",
        "PLATFORM_APPLIANCE_NODE_KEY": "localhost",
        "TEAMAIBOX_APPLIANCE_IMAGE_DIGEST": "sha256:" + "b" * 64,
        "TEAMAIBOX_APPLIANCE_CONFIGURATION_DIGEST": "sha256:" + "c" * 64,
        "TEAMAIBOX_APPLIANCE_PUBLIC_CONFIG_DIR": "/run/teamaibox-validation/config",
        "TEAMAIBOX_APPLIANCE_SCHEDULER_KEY_FILE": "/run/teamaibox-validation/scheduler.key",
        "TEAMAIBOX_APPLIANCE_GATEWAY_TLS_KEY_FILE": "/run/teamaibox-validation/gateway.key",
        "TEAMAIBOX_APPLIANCE_GATEWAY_SIGNING_KEY_FILE": "/run/teamaibox-validation/gateway-signing-key",
        "TEAMAIBOX_RELEASE_ID": "compose-validation-20260812",
        "TEAMAIBOX_DOCKER_SOCKET_GID": "988",
        "TEAMAIBOX_COMMAND_KEY_ID": "compose-validation-key",
        "TEAMAIBOX_NODE_KEY": "node-agent",
        "TEAMAIBOX_WEB_PUBLIC_ORIGIN": "https://teamaibox.validation.invalid",
        "TEAMAIBOX_WEB_BIND_ADDRESS": "0.0.0.0",
        "TEAMAIBOX_DATA_ROOT": "/var/lib/teamaibox-compose-validation",
        "TEAMAIBOX_POSTGRES_PASSWORD_FILE": "/run/teamaibox-validation/postgres-password",
        "TEAMAIBOX_NATS_TOKEN_FILE": "/run/teamaibox-validation/nats-token",
        "TEAMAIBOX_PLATFORM_AUDIT_SIGNING_KEY_FILE": "/run/teamaibox-validation/audit-key",
        "TEAMAIBOX_PLATFORM_PROVIDER_SECRET_MASTER_KEY_FILE": "/run/teamaibox-validation/provider-secret-key",
        "TEAMAIBOX_AGENT_MODEL_SIGNING_KEY_FILE": "/run/teamaibox-validation/agent-model-key",
        "TEAMAIBOX_NODE_AGENT_COMMAND_KEY_FILE": "/run/teamaibox-validation/node-command-key",
        "TEAMAIBOX_WEB_TLS_CERTIFICATE_FILE": "/run/teamaibox-validation/web.crt",
        "TEAMAIBOX_WEB_TLS_PRIVATE_KEY_FILE": "/run/teamaibox-validation/web.key",
    })
    return environment


def render_compose(overlay: pathlib.Path, environment: Mapping[str, str]) -> dict[str, Any]:
    command = [
        "docker",
        "compose",
        "--env-file",
        str(IMAGES_ENV),
        "--file",
        str(CORE_COMPOSE),
        "--file",
        str(overlay),
        "config",
        "--format",
        "json",
    ]
    completed = subprocess.run(
        command,
        cwd=ROOT,
        env={**os.environ, **environment},
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=30,
    )
    if completed.returncode != 0:
        raise DeploymentError("docker compose config failed: " + completed.stderr.strip())
    value = json.loads(completed.stdout)
    if not isinstance(value, dict):
        raise DeploymentError("docker compose config did not return an object")
    return value


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rendered", type=pathlib.Path, help="validate a pre-rendered Compose JSON file")
    parser.add_argument("--appliance", action="store_true", help="apply appliance volume checks")
    parser.add_argument(
        "--render-environment",
        choices=("development", "appliance"),
        help="render and validate a committed Compose environment",
    )
    args = parser.parse_args(argv)

    if args.rendered and args.render_environment:
        parser.error("--rendered and --render-environment are mutually exclusive")

    validate_image_lock(_load_json(IMAGE_LOCK))
    validate_resource_policy(_load_json(RESOURCE_POLICY))
    built_ins = _load_json(BUILT_IN_APPLICATIONS)
    if built_ins.get("schemaVersion") != 1 or not isinstance(built_ins.get("applications"), list):
        raise DeploymentError("built-in application release configuration is invalid")
    if args.rendered:
        validate_rendered_compose(_load_json(args.rendered), appliance=args.appliance)
    if args.render_environment:
        overlay = DEVELOPMENT_COMPOSE if args.render_environment == "development" else APPLIANCE_COMPOSE
        rendered = render_compose(overlay, validation_render_environment())
        validate_rendered_compose(rendered, appliance=args.render_environment == "appliance")
    print("deployment foundation valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
