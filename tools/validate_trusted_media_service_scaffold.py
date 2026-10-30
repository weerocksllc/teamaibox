#!/usr/bin/env python3
"""Strictly validate the blocked trusted-media service source scaffold.

Passing this validator means the implementation is fail-closed and internally
coherent.  It deliberately cannot promote OpenSpec 22.3 or authorize deployment.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
from typing import Mapping

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.trusted_media_service.host_exception_guard import evaluate_host_exceptions
from services.trusted_media_service.package_admission import PackageAdmissionGate, file_digest


PACKAGE = ROOT / "deploy/casting/trusted-media-service.package.v1.json"
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
LEGAL_GATES = {
    "uxplay-playfair-inherited-code-and-territorial-legality",
    "apple-mfi-trademark-copy-and-attribution",
    "h264-aac-alac-vp8-opus-and-nvidia-patent-clearance",
    "gplv3-lgpl-mpl-appliance-distribution-plan",
    "final-sbom-signature-provenance-vulnerability-and-source-mirror-acceptance",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def load(path: Path) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), f"{path.name} is not an object")
    return value


def local(reference: Mapping[str, object]) -> Path:
    relative = reference.get("path")
    require(isinstance(relative, str) and not relative.startswith("/") and ".." not in Path(relative).parts, "artifact path is unsafe")
    path = (ROOT / relative).resolve()
    require(path.is_relative_to(ROOT) and path.is_file(), f"artifact is missing: {relative}")
    return path


def validate(package_path: Path = PACKAGE) -> dict[str, object]:
    package = load(package_path)
    require(package.get("schemaVersion") == 1, "package schema drifted")
    require(package.get("packageId") == "teamaibox.trusted-media-service.candidate.v1", "package identity drifted")
    require(package.get("architecture") == "linux/arm64/v8", "package architecture drifted")
    require(package.get("status") == "source-scaffold-blocked", "unbuilt package claims a deployable status")

    source = package.get("sourceLock", {})
    review_ref = package.get("supplyChainReview", {})
    hardware_ref = package.get("hardwareInventory", {})
    for reference, digest_key in ((source, "sha256"), (review_ref, "sha256"), (hardware_ref, "fileSha256")):
        path = local(reference)
        require(file_digest(path) == reference.get(digest_key), f"artifact digest drifted: {path.name}")
    lock, review, hardware = load(local(source)), load(local(review_ref)), load(local(hardware_ref))
    require(lock.get("lockId") == source.get("lockId"), "source lock identity drifted")
    require(lock.get("target", {}).get("platform") == "linux/arm64/v8", "source lock target drifted")
    require(lock.get("target", {}).get("releaseEligible") is False, "pending source lock improperly became eligible")
    require(review.get("reviewId") == review_ref.get("reviewId"), "supply review identity drifted")
    require(file_digest(local(source)) == review.get("subject", {}).get("sourceLockSha256"), "supply review no longer binds source lock")
    require(set(review.get("requiredHumanDecisions", [])) == LEGAL_GATES, "five accountable legal gates drifted")
    require(review.get("decision", {}).get("releaseEligible") is False, "pending legal packet improperly became eligible")
    require(review_ref.get("releaseEligible") is False and review_ref.get("requiredHumanDecisionCount") == 5, "package hides pending legal gates")

    require(hardware.get("evidenceDigest") == hardware_ref.get("evidenceDigest"), "hardware evidence identity drifted")
    decision = hardware.get("inventory", {}).get("decision", {})
    require(decision.get("supportedEnvironment") is False, "blocked hardware packet unexpectedly claims support")
    require(hardware_ref.get("supportedEnvironment") is False, "package hides unsupported hardware")
    required_hardware_blockers = {
        "hdmi_sink_disconnected",
        "h264_encoder_plugin_missing",
        "webrtc_plugin_missing",
        "physical_apple_sender_not_exercised",
    }
    require(required_hardware_blockers <= set(decision.get("reasonCodes", [])), "hardware blockers were removed")

    policies = package.get("policies", {})
    require(set(policies) == {"runtime", "seccomp", "hostExceptions"}, "package policy set drifted")
    loaded_policies: dict[str, dict[str, object]] = {}
    for name, reference in policies.items():
        path = local(reference)
        require(file_digest(path) == reference.get("sha256"), f"{name} policy digest drifted")
        loaded_policies[name] = load(path)
    runtime, seccomp, host_exceptions = (
        loaded_policies["runtime"],
        loaded_policies["seccomp"],
        loaded_policies["hostExceptions"],
    )
    require(runtime.get("policyId") == "teamaibox.trusted-media-runtime.v1", "runtime policy identity drifted")
    trusted = runtime.get("trustedMediaService", {})
    require(trusted.get("containerUser") == "65532:65532", "trusted service is not pinned non-root")
    for key in ("readOnlyRootFilesystem", "noNewPrivileges"):
        require(trusted.get(key) is True, f"trusted service {key} is not enforced")
    require(trusted.get("privileged") is False, "trusted service is privileged")
    require(trusted.get("networkMode") == "host", "mDNS host-network exception is not explicit")
    require(trusted.get("capDrop") == ["ALL"] and trusted.get("capAdd") == [], "trusted service capabilities expanded")
    for key in ("dockerSocketMounted", "hostFilesystemMounted", "hostDbusMounted", "hostDisplaySocketMounted"):
        require(trusted.get(key) is False, f"trusted service mounts forbidden boundary: {key}")
    direct_paths = {entry.get("path") for entry in trusted.get("deviceAccess", {}).get("direct", [])}
    require(direct_paths == {
        "/dev/dri/card0",
        "/dev/dri/renderD128",
        "/dev/snd/controlC0",
        "/dev/snd/pcmC0D3p",
        "/dev/snd/pcmC0D7p",
        "/dev/snd/pcmC0D8p",
        "/dev/snd/pcmC0D9p",
    }, "trusted service direct device set expanded or drifted")
    nvidia = trusted.get("deviceAccess", {}).get("nvidiaInjection", {})
    require(nvidia.get("requiredDeviceNodes") == ["/dev/nvidia0", "/dev/nvidiactl"], "NVIDIA node set drifted")
    require(nvidia.get("broadDeviceMountForbidden") is True and nvidia.get("computeCapabilityRequested") is False, "NVIDIA boundary expanded")
    require(trusted.get("persistentWritableMounts") == [], "trusted service has persistent writable storage")
    viewer_authorization = trusted.get("browserViewerAuthorization", {})
    require(viewer_authorization == {
        "issuerBoundary": "trusted-media-service",
        "algorithm": "HS256",
        "apiSecretDelivery": "node-agent-runtime-secret-on-tmpfs",
        "apiSecretPath": "/run/teamaibox/livekit-api-secret",
        "apiSecretPersistent": False,
        "tokenState": "memory-only",
        "tokenTtlSeconds": 30,
        "oneTimeAdmissionRequired": True,
        "wssOnly": True,
        "sessionScopedRoom": True,
        "opaqueParticipantIdentity": True,
        "canSubscribe": True,
        "canPublish": False,
        "canPublishData": False,
        "maximumViewers": 8,
        "publisherEncodeRenditions": 1,
    }, "trusted service viewer authorization boundary drifted")
    require(set(trusted.get("tmpfs", {})) == {"/run/teamaibox", "/tmp"}, "trusted service tmpfs boundary drifted")
    require(all("noexec" in value for value in trusted.get("tmpfs", {}).values()), "trusted service tmpfs is executable")
    health = trusted.get("health", {})
    require(health.get("command") == ["/opt/teamaibox/bin/media-health", "--ready"], "health command drifted")
    resources = trusted.get("resources", {})
    require(resources.get("encoderReservations") == 1 and resources.get("decoderReservations") == 1, "codec reservation drifted")
    require(resources.get("browserEncodeRenditions") == 1 and resources.get("maximumBrowserViewers") == 8, "single-rendition viewer bound drifted")
    require(resources.get("maximumResolution") == "1920x1080" and resources.get("maximumFramesPerSecond") == 30, "1080p30 envelope drifted")

    plugin = runtime.get("officialApplicationPlugin", {})
    require(plugin.get("hostNetwork") is False and plugin.get("deviceAccess") == [], "official plugin gained host network or devices")
    for key in ("dockerSocketMounted", "hostFilesystemMounted", "receiverPrivateStateMounted", "directHdmiControl", "permanentMediaCredentialAccess"):
        require(plugin.get(key) is False, f"official plugin gained forbidden access: {key}")
    require(plugin.get("capDrop") == ["ALL"] and plugin.get("capAdd") == [], "official plugin capabilities expanded")
    require(plugin.get("allowedBoundary") == "authenticated-platform-casting-api-only", "official plugin bypasses platform API")

    livekit = next(component for component in lock.get("components", []) if component.get("name") == "LiveKit server")
    sfu = runtime.get("internalSfu", {})
    require(sfu.get("image") == livekit.get("arm64Image"), "runtime SFU does not bind the reviewed ARM64 digest")
    require(sfu.get("hostNetwork") is False and sfu.get("deviceAccess") == [], "SFU gained host network or devices")
    require(sfu.get("dockerSocketMounted") is False and sfu.get("readOnlyRootFilesystem") is True, "SFU isolation drifted")
    require(sfu.get("viewerAuthorization") == {
        "apiSecretDelivery": "same-node-tmpfs-runtime-secret",
        "apiSecretPersistent": False,
        "issuer": "trusted-media-service",
        "algorithm": "HS256",
        "maximumTokenTtlSeconds": 30,
        "roomJoinOnly": True,
        "subscriberOnly": True,
        "publishAllowed": False,
        "dataPublishAllowed": False,
    }, "SFU viewer authorization boundary drifted")

    require(seccomp.get("defaultAction") == "SCMP_ACT_ERRNO" and seccomp.get("architectures") == ["SCMP_ARCH_AARCH64"], "seccomp is not explicit ARM64 deny-by-default")
    allowed_syscalls = {name for group in seccomp.get("syscalls", []) if group.get("action") == "SCMP_ACT_ALLOW" for name in group.get("names", [])}
    require({"socket", "bind", "connect", "ioctl", "mmap", "futex", "execve"} <= allowed_syscalls, "seccomp lacks the bounded media runtime primitives")
    forbidden_syscalls = {
        "bpf", "chroot", "delete_module", "finit_module", "init_module", "kexec_load", "keyctl",
        "mount", "open_by_handle_at", "perf_event_open", "pivot_root", "ptrace", "reboot", "setns",
        "swapon", "swapoff", "umount2", "unshare",
    }
    require(not (allowed_syscalls & forbidden_syscalls), "seccomp permits a host-control syscall")

    require(host_exceptions.get("policy") == "deny-unregistered", "host exceptions are not deny-by-default")
    foundation = host_exceptions.get("allowedHostFoundation", {})
    for key in ("hostPackageInstalls", "hostServiceChanges", "hostConfigurationChanges", "kernelModuleChanges", "firewallOrRouteChanges"):
        require(foundation.get(key) == [], f"host exception permits mutation: {key}")
    require({item.get("key") for item in host_exceptions.get("exceptions", [])} == {
        "trusted-media.host-network",
        "trusted-media.drm-render-devices",
        "trusted-media.hdmi-audio-devices",
        "trusted-media.nvidia-video-runtime",
    }, "unavoidable host exception set drifted")
    drift_result = evaluate_host_exceptions(host_exceptions, hardware)
    require(drift_result.get("mutationPerformed") is False, "host drift guard mutated the host")
    require(drift_result.get("releaseEvidenceEligible") is False, "incomplete host proof became release eligible")
    require(any(item.get("key") == "service:docker.service" for item in drift_result.get("drifts", [])), "unobserved Docker service did not fail closed")

    build = package.get("build", {})
    dockerfile = local(build.get("dockerfile", {}))
    require(file_digest(dockerfile) == build.get("dockerfile", {}).get("sha256"), "Dockerfile digest drifted")
    require(
        build.get("context") == "deploy/casting/trusted-media-service-rootfs",
        "trusted service rootfs build context drifted",
    )
    rootfs_context = (ROOT / str(build.get("context"))).resolve()
    require(
        rootfs_context.is_relative_to(ROOT) and not rootfs_context.exists(),
        "controlled trusted-media rootfs unexpectedly exists in the source scaffold",
    )
    docker_text = dockerfile.read_text(encoding="utf-8")
    require(docker_text.startswith("FROM scratch\n"), "trusted service has an unpinned base image")
    require(
        "COPY ./ /" in docker_text
        and "COPY --chown=" not in docker_text
        and "COPY rootfs/ /" not in docker_text,
        "Dockerfile COPY source does not match the isolated rootfs build context",
    )
    require("USER 65532:65532" in docker_text and "HEALTHCHECK" in docker_text and "ENTRYPOINT" in docker_text, "Dockerfile isolation/health contract is incomplete")
    require(not re.search(r"(?m)^\s*RUN\s", docker_text), "source scaffold performs a network/package build")
    require(build.get("buildPerformed") is False and build.get("reproducible") is False, "unbuilt rootfs claims build completion")
    require(build.get("rootfsManifest") is None and build.get("rootfsManifestSha256") is None, "missing rootfs has a fabricated manifest")
    require(package.get("images", {}).get("trustedMediaService", {}).get("arm64Digest") is None, "trusted media image digest was fabricated")

    lifecycle = package.get("lifecycle", {})
    require(lifecycle.get("dockerControlBoundary") == "signed-mtls-node-agent-adapter-only", "lifecycle bypasses Node Agent")
    require(lifecycle.get("dockerSocketMounted") is False, "lifecycle requests the Docker socket")
    require(set(lifecycle.get("operations", [])) == {"stage", "start", "upgrade", "rollback", "stop", "uninstall", "recover"}, "lifecycle operation set drifted")
    for relative in (lifecycle.get("controller"), lifecycle.get("hostDriftGuard")):
        require(isinstance(relative, str) and (ROOT / relative).is_file(), "lifecycle implementation is missing")
    token_issuer = lifecycle.get("viewerTokenIssuer")
    require(token_issuer == "services/trusted_media_service/viewer_token_issuer.py"
            and (ROOT / token_issuer).is_file(), "viewer token issuer implementation is missing")
    internal_api = lifecycle.get("internalControlApi")
    require(internal_api == "services/trusted_media_service/runtime_api.py"
            and (ROOT / internal_api).is_file(), "internal control API implementation is missing")

    claims = package.get("claimBoundary", {})
    require(claims == {
        "sourceScaffoldReady": True,
        "containerBuilt": False,
        "deploymentPerformed": False,
        "componentReady": False,
        "productAccepted": False,
        "releaseEligible": False,
        "task22_1Complete": False,
        "task22_3Complete": False,
        "task22_10Complete": False,
    }, "claim boundary drifted")
    blockers = set(package.get("admission", {}).get("currentBlockers", []))
    require(required_hardware_blockers <= blockers, "package hides hardware blockers")
    require("airplay_supply_chain_human_decisions_pending" in blockers, "package hides legal blockers")

    synthetic_release = {
        "releaseId": "trusted-media-candidate-validation",
        "architecture": "linux/arm64/v8",
        "trustedMediaImageDigest": "sha256:" + "1" * 64,
        "sfuImageDigest": package["images"]["internalSfu"]["arm64Digest"],
        "runtimePolicyDigest": package["policies"]["runtime"]["sha256"],
        "sourceLockDigest": package["sourceLock"]["sha256"],
        "hardwareEvidenceDigest": package["hardwareInventory"]["evidenceDigest"],
        "rootfsManifestDigest": "sha256:" + "2" * 64,
        "releaseEligible": True,
        "hardwareSupported": True,
        "healthTimeoutSeconds": 30,
    }
    gate = PackageAdmissionGate(repository_root=ROOT, package_path=package_path)
    gate_blockers = set(gate(synthetic_release))
    require("airplay_supply_chain_human_decisions_pending" in gate_blockers, "runtime admission ignores pending legal review")
    require(required_hardware_blockers <= gate_blockers, "runtime admission ignores hardware blockers")
    require("trusted_media_arm64_image_unbuilt" in gate_blockers, "runtime admission ignores missing image")

    return {
        "valid": True,
        "packageId": package["packageId"],
        "sourceScaffoldReady": True,
        "deployable": False,
        "componentReady": False,
        "productAccepted": False,
        "releaseEligible": False,
        "task22_3Complete": False,
        "legalGateCount": len(LEGAL_GATES),
        "admissionBlockers": sorted(gate_blockers),
        "hostDriftCount": len(drift_result["drifts"]),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", type=Path, default=PACKAGE)
    arguments = parser.parse_args()
    print(json.dumps(validate(arguments.package), sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
