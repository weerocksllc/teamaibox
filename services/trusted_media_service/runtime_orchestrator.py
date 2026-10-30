"""Fail-closed manifest, health, reservation, and runtime orchestration.

This module is deliberately a narrow Node Agent client.  It cannot execute an
arbitrary command and never opens the Docker socket.  The committed manifest is
a blocked component template; materialization is possible only after an
external admission gate accepts an exact release and exact reproducible build
evidence.
"""

from __future__ import annotations

from copy import deepcopy
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import shlex
from typing import Callable, Mapping, Protocol, Sequence


ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = ROOT / "deploy/casting/trusted-media-release-set.template.v1.json"
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
NON_ROOT_USER = re.compile(r"^[1-9][0-9]*:[1-9][0-9]*$")
RELEASE_ID = re.compile(r"^[a-z0-9][a-z0-9.-]{0,126}[a-z0-9]$")
RELEASE_KEYS = {
    "releaseId",
    "architecture",
    "trustedMediaImageDigest",
    "sfuImageDigest",
    "runtimePolicyDigest",
    "sourceLockDigest",
    "hardwareEvidenceDigest",
    "rootfsManifestDigest",
    "releaseEligible",
    "hardwareSupported",
    "healthTimeoutSeconds",
}
BUILD_EVIDENCE_KEYS = {
    "rootfsManifestDigest",
    "twoIndependentBuildDigests",
    "observedGstreamerElements",
    "observedForbiddenGstreamerElements",
}
HEALTH_KEYS = {
    "schemaVersion",
    "releaseId",
    "trustedMediaImageDigest",
    "sfuImageDigest",
    "phase",
    "supervisorReady",
    "sfuReady",
    "serviceReservationProfileDigest",
    "serviceReservationActive",
    "sessionReservationProfileDigest",
    "sessionReservationActive",
    "receiverRunning",
    "mdnsAdvertised",
    "selectedSinks",
    "sinkHealth",
    "publisherEncodeRenditions",
    "viewerCount",
    "ephemeralStateOnTmpfs",
}


class TrustedMediaContractError(ValueError):
    """A stable, non-secret component-contract failure."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise TrustedMediaContractError(message)


def canonical_digest(value: object) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def file_digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _object(value: object, name: str) -> Mapping[str, object]:
    require(isinstance(value, Mapping), f"{name} must be an object")
    return value


def _load(path: Path) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise TrustedMediaContractError(f"cannot read {path.name}") from error
    require(isinstance(value, dict), f"{path.name} must contain an object")
    return value


def _bound_file(reference: object) -> tuple[Path, dict[str, object]]:
    value = dict(_object(reference, "binding"))
    require(set(value) == {"path", "sha256"}, "binding fields are not exact")
    relative, expected = value.get("path"), value.get("sha256")
    require(
        isinstance(relative, str)
        and not relative.startswith("/")
        and ".." not in Path(relative).parts,
        "binding path is unsafe",
    )
    path = (ROOT / relative).resolve()
    require(path.is_relative_to(ROOT) and path.is_file(), f"bound file is missing: {relative}")
    require(isinstance(expected, str) and DIGEST.fullmatch(expected) is not None, "binding digest is invalid")
    require(file_digest(path) == expected, f"bound file digest drifted: {relative}")
    return path, _load(path)


def validate_component_template(path: Path = TEMPLATE) -> dict[str, object]:
    """Validate the committed, intentionally non-deployable release-set template."""

    manifest = _load(path)
    require(manifest.get("schemaVersion") == 1, "release-set schema drifted")
    require(manifest.get("manifestId") == "teamaibox.trusted-media-release-set.template.v1", "release-set identity drifted")
    require(manifest.get("architecture") == "linux/arm64/v8", "release-set architecture drifted")
    require(manifest.get("status") == "component-template-blocked", "template claims a materialized status")

    bindings = _object(manifest.get("bindings"), "bindings")
    require(set(bindings) == {"package", "runtimePolicy", "seccomp", "hostExceptions", "officialApplicationPlugin"}, "binding set drifted")
    bound = {name: _bound_file(reference)[1] for name, reference in bindings.items()}
    package = bound["package"]
    runtime = bound["runtimePolicy"]
    seccomp = bound["seccomp"]
    host_exceptions = bound["hostExceptions"]
    plugin = bound["officialApplicationPlugin"]

    require(package.get("status") == "source-scaffold-blocked", "template no longer binds the blocked package")
    require(package.get("claimBoundary", {}).get("task22_3Complete") is False, "bound package overclaims task 22.3")
    require(runtime.get("policyId") == "teamaibox.trusted-media-runtime.v1", "runtime policy identity drifted")
    require(seccomp.get("defaultAction") == "SCMP_ACT_ERRNO", "seccomp is not deny-by-default")
    require(host_exceptions.get("policy") == "deny-unregistered", "host exception policy is not deny-by-default")

    build = _object(manifest.get("buildContract"), "build contract")
    require(build.get("mode") == "controlled-offline-rootfs" and build.get("buildNetwork") == "none", "build is not controlled offline")
    require(build.get("runtimeBase") == "scratch", "runtime base is not scratch")
    require(build.get("sourceDateEpochRequired") is True, "reproducible timestamp is not required")
    require(build.get("twoIndependentArm64BuildsRequired") is True, "two independent ARM64 builds are not required")
    require(build.get("matchingOciManifestDigestsRequired") is True, "matching OCI digests are not required")
    require(build.get("rootfsManifestDigest") is None and build.get("trustedMediaImageDigest") is None, "template fabricates build digests")
    require(build.get("twoIndependentBuildDigests") == [], "template fabricates reproducible builds")
    require(build.get("observedGstreamerElements") == [] and build.get("observedForbiddenGstreamerElements") == [], "template fabricates GStreamer inspection")
    required_executables = set(build.get("requiredExecutables", []))
    require(required_executables == {
        "/opt/teamaibox/bin/media-health",
        "/opt/teamaibox/bin/teamaibox-media-supervisor",
        "/usr/bin/gst-inspect-1.0",
        "/usr/bin/gst-launch-1.0",
        "/usr/bin/uxplay",
    }, "rootfs executable contract drifted")
    required_elements = set(build.get("requiredGstreamerElements", []))
    lock = _load(ROOT / "deploy/casting/airplay-compatible-stack.lock.json")
    gstreamer = next(item for item in lock.get("components", []) if item.get("name") == "GStreamer monorepo")
    webrtc = next(item for item in lock.get("components", []) if item.get("name") == "gst-plugins-rs gst-plugin-webrtc")
    require(required_elements == set(gstreamer.get("selectedRuntimeElements", [])) | set(webrtc.get("selectedElements", [])), "GStreamer element contract no longer matches the source lock")
    require(not (required_elements & set(build.get("forbiddenGstreamerElements", []))), "required and forbidden GStreamer elements overlap")
    dockerfile_path = ROOT / str(build.get("dockerfile"))
    require(dockerfile_path.is_file(), "trusted-media Dockerfile is missing")
    dockerfile = dockerfile_path.read_text(encoding="utf-8")
    require(dockerfile.startswith("FROM scratch\n") and "COPY ./ /" in dockerfile, "trusted-media image is not an isolated scratch assembly")
    require(re.search(r"(?m)^\s*RUN\s", dockerfile) is None, "trusted-media image performs an in-image build")

    services = _object(manifest.get("services"), "services")
    require(set(services) == {"trustedMedia", "internalSfu"}, "release-set service set drifted")
    trusted = _object(services.get("trustedMedia"), "trusted media service")
    policy_trusted = _object(runtime.get("trustedMediaService"), "runtime trusted media service")
    require(trusted.get("imageDigest") is None, "template fabricates the trusted-media image")
    require(trusted.get("entrypoint") == ["/opt/teamaibox/bin/teamaibox-media-supervisor"], "trusted-media entrypoint drifted")
    require(trusted.get("user") == policy_trusted.get("containerUser") == "65532:65532", "trusted-media user drifted")
    for key in ("readOnlyRootFilesystem", "noNewPrivileges"):
        require(trusted.get(key) is True and policy_trusted.get(key) is True, f"trusted-media {key} is not enforced")
    require(trusted.get("privileged") is False, "trusted-media service is privileged")
    require(trusted.get("network", {}).get("mode") == "host", "mDNS host-network exception is not explicit")
    require(trusted.get("network", {}).get("exceptionKey") == "trusted-media.host-network", "mDNS host-network exception identity drifted")
    require(trusted.get("network", {}).get("sameLayer2Only") is True, "mDNS network boundary widened beyond same-L2")
    require(trusted.get("network", {}).get("advertiseOnlyDuringAdmittedSession") is True, "mDNS may advertise outside an admitted session")
    security = _object(trusted.get("security"), "trusted-media security")
    require(security.get("capDrop") == ["ALL"] and security.get("capAdd") == [], "trusted-media capabilities expanded")
    require(security.get("seccompProfile") == policy_trusted.get("seccompProfile") == "deploy/casting/trusted-media-seccomp.v1.json", "trusted-media seccomp profile drifted")
    require(security.get("apparmorProfileRequired") is True and policy_trusted.get("apparmorProfileRequiredAtRelease") is True, "trusted-media AppArmor is not required")
    for key in ("dockerSocketMounted", "hostPid", "hostIpc", "hostDbusMounted", "hostFilesystemMounted", "hostDisplaySocketMounted"):
        require(security.get(key) is False, f"trusted-media gained forbidden access: {key}")
    direct_entries = trusted.get("deviceAllowlist", [])
    require(isinstance(direct_entries, list), "trusted-media device allowlist is invalid")
    direct_paths = {item.get("path") for item in direct_entries if isinstance(item, Mapping)}
    policy_direct = policy_trusted.get("deviceAccess", {}).get("direct", [])
    policy_paths = {item.get("path") for item in policy_direct}
    require(len(direct_entries) == len(direct_paths), "trusted-media device allowlist contains duplicates")
    require(len(direct_paths) == len(policy_direct), "trusted-media device set drifted from runtime policy")
    require(direct_paths == policy_paths, "trusted-media device set drifted from runtime policy")
    policy_access = {item.get("path"): item.get("access") for item in policy_direct}
    exception_by_path = {
        "/dev/dri/card0": "trusted-media.drm-render-devices",
        "/dev/dri/renderD128": "trusted-media.drm-render-devices",
        "/dev/snd/controlC0": "trusted-media.hdmi-audio-devices",
        "/dev/snd/pcmC0D3p": "trusted-media.hdmi-audio-devices",
        "/dev/snd/pcmC0D7p": "trusted-media.hdmi-audio-devices",
        "/dev/snd/pcmC0D8p": "trusted-media.hdmi-audio-devices",
        "/dev/snd/pcmC0D9p": "trusted-media.hdmi-audio-devices",
    }
    require(
        all(
            set(item) == {"path", "access", "exceptionKey"}
            and item.get("access") == policy_access.get(item.get("path"))
            and item.get("exceptionKey") == exception_by_path.get(item.get("path"))
            for item in direct_entries
        ),
        "trusted-media device access or exception identity drifted",
    )
    require(trusted.get("devices") == [], "blocked template preselects host devices")
    selection = _object(trusted.get("deviceSelection"), "device selection")
    fixed_devices = ["/dev/dri/card0", "/dev/dri/renderD128", "/dev/snd/controlC0"]
    pcm_devices = ["/dev/snd/pcmC0D3p", "/dev/snd/pcmC0D7p", "/dev/snd/pcmC0D8p", "/dev/snd/pcmC0D9p"]
    require(selection.get("fixed") == fixed_devices, "fixed media device selection drifted")
    require(selection.get("hdmiPlaybackAllowlist") == pcm_devices, "HDMI playback allowlist drifted")
    require(selection.get("selectedHdmiPlayback") is None and selection.get("exactlyOneHdmiPlaybackRequired") is True, "template fabricates or widens HDMI playback selection")
    nvidia = _object(trusted.get("nvidia"), "trusted-media NVIDIA boundary")
    policy_nvidia = _object(policy_trusted.get("deviceAccess", {}).get("nvidiaInjection"), "runtime NVIDIA boundary")
    require(nvidia.get("driverCapabilities") == policy_trusted.get("nvidiaDriverCapabilities") == ["utility", "video"], "NVIDIA driver capabilities drifted")
    require(nvidia.get("deviceNodes") == policy_nvidia.get("requiredDeviceNodes") == ["/dev/nvidia0", "/dev/nvidiactl"], "NVIDIA device nodes drifted")
    require(nvidia.get("computeCapabilityRequested") is False and policy_nvidia.get("computeCapabilityRequested") is False, "NVIDIA compute capability was requested")
    require(nvidia.get("broadDeviceMountForbidden") is True and policy_nvidia.get("broadDeviceMountForbidden") is True, "NVIDIA device boundary widened")
    require(trusted.get("persistentWritableMounts") == [], "trusted-media gained persistent writes")
    viewer_authorization = _object(policy_trusted.get("browserViewerAuthorization"), "viewer authorization")
    require(viewer_authorization.get("issuerBoundary") == "trusted-media-service", "viewer authorization issuer drifted")
    require(viewer_authorization.get("algorithm") == "HS256", "viewer authorization algorithm drifted")
    require(viewer_authorization.get("apiSecretDelivery") == "node-agent-runtime-secret-on-tmpfs"
            and viewer_authorization.get("apiSecretPath") == "/run/teamaibox/livekit-api-secret"
            and viewer_authorization.get("apiSecretPersistent") is False,
            "viewer authorization secret boundary drifted")
    require(viewer_authorization.get("tokenState") == "memory-only"
            and viewer_authorization.get("tokenTtlSeconds") == 30
            and viewer_authorization.get("oneTimeAdmissionRequired") is True,
            "viewer authorization lifetime drifted")
    require(viewer_authorization.get("wssOnly") is True
            and viewer_authorization.get("sessionScopedRoom") is True
            and viewer_authorization.get("opaqueParticipantIdentity") is True,
            "viewer authorization binding drifted")
    require(viewer_authorization.get("canSubscribe") is True
            and viewer_authorization.get("canPublish") is False
            and viewer_authorization.get("canPublishData") is False
            and (viewer_authorization.get("maximumViewers") is None or type(viewer_authorization.get("maximumViewers")) is int and viewer_authorization["maximumViewers"] > 0)
            and viewer_authorization.get("publisherEncodeRenditions") == 1,
            "viewer authorization privilege drifted")
    require(trusted.get("tmpfs") == policy_trusted.get("tmpfs"), "trusted-media tmpfs contract drifted")
    require(trusted.get("health", {}).get("command") == ["/opt/teamaibox/bin/media-health", "--ready"], "health command drifted")

    exceptions = host_exceptions.get("exceptions", [])
    require(isinstance(exceptions, list), "host exception list is invalid")
    exception_scopes = {item.get("key"): item.get("scope") for item in exceptions if isinstance(item, Mapping)}
    require(set(exception_scopes) == {
        "trusted-media.host-network",
        "trusted-media.drm-render-devices",
        "trusted-media.hdmi-audio-devices",
        "trusted-media.nvidia-video-runtime",
    }, "host exception set drifted")
    require(exception_scopes["trusted-media.host-network"] == "trusted media service container only", "host-network exception scope drifted")
    require(exception_scopes["trusted-media.drm-render-devices"] == fixed_devices[:2], "DRM exception scope drifted")
    require(exception_scopes["trusted-media.hdmi-audio-devices"] == [fixed_devices[2], *pcm_devices], "HDMI audio exception scope drifted")
    require(exception_scopes["trusted-media.nvidia-video-runtime"] == nvidia.get("deviceNodes"), "NVIDIA exception scope drifted")

    sfu = _object(services.get("internalSfu"), "internal SFU")
    policy_sfu = _object(runtime.get("internalSfu"), "runtime internal SFU")
    expected_sfu_digest = package.get("images", {}).get("internalSfu", {}).get("arm64Digest")
    require(sfu.get("imageDigest") == expected_sfu_digest, "SFU digest drifted from reviewed package")
    require(sfu.get("user") is None and sfu.get("runAsNonRootRequired") is True, "template hides unresolved SFU runtime user")
    require(sfu.get("readOnlyRootFilesystem") is True and sfu.get("noNewPrivileges") is True and sfu.get("privileged") is False, "SFU isolation drifted")
    sfu_security = _object(sfu.get("security"), "SFU security")
    require(sfu_security.get("capDrop") == ["ALL"] and sfu_security.get("capAdd") == [], "SFU capabilities expanded")
    require(sfu_security.get("dockerSocketMounted") is False and sfu_security.get("deviceAccess") == [], "SFU gained host control or devices")
    require(sfu_security.get("seccompProfile") == "deploy/casting/trusted-media-seccomp.v1.json", "SFU seccomp profile drifted")
    require(sfu_security.get("apparmorProfileRequired") is True, "SFU AppArmor is not required")
    require(policy_sfu.get("viewerAuthorization") == {
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
    network = _object(sfu.get("network"), "SFU network")
    require(network.get("mode") == "bridge" and network.get("name") == policy_sfu.get("networkMode"), "SFU network boundary drifted")
    require(network.get("control") == {"containerPort": 7880, "hostAddress": "127.0.0.1", "hostPort": 7880, "protocol": "tcp"}, "SFU control is not loopback-only")
    for name, port, protocol in (("rtcTcp", 7881, "tcp"), ("rtcUdp", 7882, "udp")):
        endpoint = _object(network.get(name), name)
        require(endpoint.get("containerPort") == port and endpoint.get("hostPort") == port and endpoint.get("protocol") == protocol, f"{name} port drifted")
        require(endpoint.get("hostAddress") is None and endpoint.get("approvedSameLayer2AddressRequired") is True, f"{name} template fabricates a LAN binding")
    require(network.get("turnEnabled") is False and network.get("publicInternetTraversalEnabled") is False, "SFU widened beyond same-LAN scope")
    require(sfu.get("health") == {
        "type": "node-agent-tcp-connect",
        "containerPort": 7880,
        "intervalSeconds": 5,
        "timeoutSeconds": 2,
        "startPeriodSeconds": 30,
        "retries": 6,
    }, "SFU health probe drifted")

    media = _object(manifest.get("mediaContract"), "media contract")
    require(media.get("recordingEnabled") is False and media.get("hevcEnabled") is False and media.get("hlsEnabled") is False, "media scope expanded")
    require(media.get("browserVideoCodec") == "VP8" and media.get("browserAudioCodec") == "Opus", "browser codec contract drifted")
    require(media.get("maximumResolution") == "1920x1080" and media.get("maximumFramesPerSecond") == 30, "1080p30 envelope drifted")
    viewer_limit = media.get("maximumBrowserViewers")
    require((viewer_limit is None or type(viewer_limit) is int and viewer_limit > 0)
            and media.get("publisherEncodeRenditions") == 1, "viewer policy or publisher encode count is invalid")
    require(media.get("browserViewerAuthorization") == {
        "issuer": "trusted-media-service",
        "implementation": "services/trusted_media_service/viewer_token_issuer.py",
        "algorithm": "HS256",
        "tokenTtlSeconds": 30,
        "tokenState": "memory-only",
        "oneTimeAdmissionRequired": True,
        "wssOnly": True,
        "sessionScopedRoom": True,
        "subscriberOnly": True,
        "publishAllowed": False,
        "dataPublishAllowed": False,
    }, "browser viewer authorization contract drifted")
    supervisor = _object(media.get("supervisorProcessPolicy"), "supervisor process policy")
    session_policy = _object(lock.get("pipelinePolicy", {}).get("sessionAuthentication"), "locked session authentication")
    require(supervisor.get("shellExecutionAllowed") is False, "media supervisor permits shell execution")
    require(supervisor.get("inheritedUxplayConfigurationAllowed") is False and supervisor.get("uxplayrcEnvironmentAllowed") is False, "media supervisor permits inherited UxPlay configuration")
    require(supervisor.get("childStdoutPolicy") == "discard" and supervisor.get("childStderrPolicy") == "safe-error-class-only", "media child output may expose device or pairing state")
    locked_arguments = [part for option in session_policy.get("requiredOptions", []) for part in shlex.split(str(option))]
    require(supervisor.get("fixedArguments") == locked_arguments, "fixed UxPlay argument policy drifted")
    require(supervisor.get("allowedDynamicArguments") == [item.get("option") for item in session_policy.get("allowedDynamicOptions", [])], "dynamic UxPlay argument policy drifted")
    require(supervisor.get("forbiddenArguments") == session_policy.get("forbiddenOptions"), "forbidden UxPlay argument policy drifted")

    reservation = _object(manifest.get("reservation"), "reservation")
    trusted_resources = _object(policy_trusted.get("resources"), "trusted-media resources")
    sfu_resources = _object(policy_sfu.get("resources"), "SFU resources")
    for total, key in (
        (trusted_resources.get("cpuReservationMillis", 0) + sfu_resources.get("cpuReservationMillis", 0), "cpuReservationMillis"),
        (trusted_resources.get("cpuLimitMillis", 0) + sfu_resources.get("cpuLimitMillis", 0), "cpuLimitMillis"),
        (trusted_resources.get("memoryReservationBytes", 0) + sfu_resources.get("memoryReservationBytes", 0), "memoryReservationBytes"),
        (trusted_resources.get("memoryHardLimitBytes", 0) + sfu_resources.get("memoryHardLimitBytes", 0), "memoryHardLimitBytes"),
        (trusted_resources.get("pidsLimit", 0) + sfu_resources.get("pidsLimit", 0), "pidsLimit"),
    ):
        require(reservation.get(key) == total, f"aggregate reservation {key} drifted")
    require(reservation.get("profileId") == "trusted-media-service.arm64.v1", "service reservation identity drifted")
    require(reservation.get("protectedOfficeProfilesEvictable") is False and reservation.get("admitBeforeStart") is True, "service reservation may evict or start before admission")
    require(reservation.get("releaseAfterServiceStopAndStateClear") is True, "service reservation can be released before cleanup")
    session_reservation = _object(manifest.get("sessionReservation"), "session reservation")
    for key in ("decoderReservations", "encoderReservations", "displayReservations", "audioReservations", "networkReservationBitsPerSecond"):
        require(session_reservation.get(key) == trusted_resources.get(key), f"media session reservation {key} drifted")
    require(session_reservation.get("profileId") == "realtime.cast-webrtc.arm64.v1", "media session reservation identity drifted")
    reservation_viewers = session_reservation.get("maximumBrowserViewers")
    require((reservation_viewers is None or type(reservation_viewers) is int and reservation_viewers > 0)
            and session_reservation.get("publisherEncodeRenditions") == 1, "media session viewer policy or encode reservation is invalid")
    require(session_reservation.get("protectedOfficeProfilesEvictable") is False, "media session reservation may evict protected office profiles")
    require(session_reservation.get("acquireBeforeReceiverStartAndAdvertisement") is True, "media session can advertise before reservation")
    require(session_reservation.get("releaseAfterAdvertisementWithdrawalAndStateClear") is True, "media session reservation can release before cleanup")
    require(session_reservation.get("selectionRules") == {
        "decoder": "always-one",
        "encoder": "one-only-when-browser-selected",
        "display": "one-only-when-hdmi-selected",
        "audio": "one-only-when-hdmi-selected",
        "network": "bounded-ingress-plus-one-sfu-rendition",
    }, "media session reservation selection rules drifted")

    health = _object(manifest.get("healthContract"), "health contract")
    require(health.get("phases") == ["idle", "active"], "health phases drifted")
    require(health.get("idle", {}).get("mdnsAdvertised") is False and health.get("idle", {}).get("receiverRunning") is False, "idle health permits an advertised receiver")
    require(health.get("idle", {}).get("serviceReservationActive") is True and health.get("idle", {}).get("sessionReservationActive") is False, "idle health retains a media session reservation")
    require(health.get("active", {}).get("serviceReservationActive") is True and health.get("active", {}).get("sessionReservationActive") is True, "active health lacks an admitted media reservation")
    require(health.get("active", {}).get("publisherEncodeRenditionsWhenBrowserSelected") == 1, "active health permits per-viewer encoding")
    require(set(health.get("forbiddenFields", [])) >= {"pairingPin", "privateKey", "mediaCredential", "deviceLabel", "decodedFrame"}, "health contract permits secret or media fields")

    lifecycle = _object(manifest.get("lifecycle"), "lifecycle")
    require(lifecycle.get("controlBoundary") == "signed-mtls-node-agent-narrow-operations-only", "lifecycle is not Node-Agent-only")
    require(lifecycle.get("dockerSocketMounted") is False, "lifecycle mounts the Docker socket")
    require(lifecycle.get("slots") == ["active", "candidate", "previous"], "atomic release slots drifted")
    require(lifecycle.get("activationOrder") == ["admission", "service-reservation", "sfu-start", "sfu-health", "trusted-media-start", "release-set-health", "atomic-active-identity-commit"], "activation order drifted")
    require(lifecycle.get("quiesceOrder") == ["withdraw-discovery", "trusted-media-stop", "sfu-stop", "clear-ephemeral-state", "release-service-reservation"], "quiesce order drifted")
    require(lifecycle.get("failedCandidateAction") == "remove-candidate-and-restore-previous-exact-release", "failed candidate does not restore the previous release")

    plugin_boundary = _object(manifest.get("officialApplicationPluginBoundary"), "plugin boundary")
    plugin_permissions = _object(plugin.get("permissions"), "plugin permissions")
    require(plugin_boundary.get("pluginId") == plugin.get("id") == "official.wireless-casting", "official plugin identity drifted")
    require(plugin_boundary.get("networkMode") == "none", "official plugin gained a runtime network")
    require(plugin_permissions.get("devices") == [] and plugin_permissions.get("network") == {"mode": "none", "egressHosts": []}, "official plugin gained devices or network")
    for key in ("dockerSocketMounted", "hostFilesystemMounted", "receiverPrivateStateMounted", "directHdmiControl", "permanentMediaCredentialAccess"):
        require(plugin_boundary.get(key) is False, f"official plugin gained forbidden boundary: {key}")

    activation = _object(manifest.get("activationGate"), "activation gate")
    require(activation.get("materialized") is False and len(activation.get("currentBlockers", [])) >= 9, "blocked template became activatable")
    claims = _object(manifest.get("claimBoundary"), "claim boundary")
    require(claims.get("componentContractReady") is True, "component contract is not declared")
    for key in ("containerBuilt", "deploymentPerformed", "realMediaProcessed", "componentReady", "productAccepted", "releaseEligible", "task22_1Complete", "task22_3Complete"):
        require(claims.get(key) is False, f"template overclaims {key}")
    return {
        "valid": True,
        "manifestId": manifest["manifestId"],
        "componentContractReady": True,
        "materialized": False,
        "componentReady": False,
        "releaseEligible": False,
        "task22_3Complete": False,
        "requiredExecutableCount": len(required_executables),
        "requiredGstreamerElementCount": len(required_elements),
        "deviceCount": len(direct_paths),
    }


def _validate_release(release: Mapping[str, object]) -> None:
    require(set(release) == RELEASE_KEYS, "release descriptor fields are not exact")
    require(isinstance(release.get("releaseId"), str) and RELEASE_ID.fullmatch(str(release["releaseId"])) is not None, "release identity is invalid")
    require(release.get("architecture") == "linux/arm64/v8", "release architecture is not ARM64")
    for key in ("trustedMediaImageDigest", "sfuImageDigest", "runtimePolicyDigest", "sourceLockDigest", "hardwareEvidenceDigest", "rootfsManifestDigest"):
        require(isinstance(release.get(key), str) and DIGEST.fullmatch(str(release[key])) is not None, f"release {key} is not pinned")
    require(release.get("releaseEligible") is True and release.get("hardwareSupported") is True, "release is not eligible")
    timeout = release.get("healthTimeoutSeconds")
    require(isinstance(timeout, int) and not isinstance(timeout, bool) and 5 <= timeout <= 300, "release health timeout is invalid")


def materialize_release_set(
    release: Mapping[str, object],
    build_evidence: Mapping[str, object],
    *,
    approved_lan_address: str,
    sfu_user: str,
    selected_hdmi_playback: str,
    admission_check: Callable[[Mapping[str, object]], Sequence[str]],
    template_path: Path = TEMPLATE,
) -> dict[str, object]:
    """Materialize an exact candidate without deploying or opening Docker.

    The caller must supply the same fail-closed admission check used by the
    lifecycle controller.  Current committed inputs intentionally fail it.
    """

    validate_component_template(template_path)
    _validate_release(release)
    blockers = tuple(sorted(set(admission_check(release))))
    require(not blockers, "release admission is blocked: " + ",".join(blockers))
    require(set(build_evidence) == BUILD_EVIDENCE_KEYS, "build evidence fields are not exact")
    rootfs_digest = build_evidence.get("rootfsManifestDigest")
    require(rootfs_digest == release.get("rootfsManifestDigest"), "rootfs manifest digest does not match release")
    builds = build_evidence.get("twoIndependentBuildDigests")
    require(isinstance(builds, list) and len(builds) == 2, "exactly two independent build digests are required")
    require(all(item == release.get("trustedMediaImageDigest") for item in builds), "independent ARM64 builds are not reproducible")

    manifest = _load(template_path)
    required = set(manifest["buildContract"]["requiredGstreamerElements"])
    observed = build_evidence.get("observedGstreamerElements")
    forbidden_observed = build_evidence.get("observedForbiddenGstreamerElements")
    require(isinstance(observed, list) and set(observed) == required and len(observed) == len(required), "required GStreamer element inspection is incomplete")
    require(forbidden_observed == [], "forbidden GStreamer elements were observed")
    require(NON_ROOT_USER.fullmatch(sfu_user) is not None, "SFU runtime user is not a pinned non-root uid:gid")
    try:
        address = ipaddress.ip_address(approved_lan_address)
    except ValueError as error:
        raise TrustedMediaContractError("SFU LAN address is invalid") from error
    require(
        address.version == 4
        and address.is_private
        and not address.is_loopback
        and not address.is_link_local
        and not address.is_multicast
        and not address.is_unspecified,
        "SFU media address is not an approved private same-L2 IPv4 address",
    )
    require(release.get("sfuImageDigest") == manifest["services"]["internalSfu"]["imageDigest"], "release SFU digest drifted")
    runtime_digest = manifest["bindings"]["runtimePolicy"]["sha256"]
    require(release.get("runtimePolicyDigest") == runtime_digest, "release runtime policy digest drifted")
    package = _load(ROOT / manifest["bindings"]["package"]["path"])
    require(release.get("sourceLockDigest") == package.get("sourceLock", {}).get("sha256"), "release source lock digest drifted")
    require(release.get("hardwareEvidenceDigest") == package.get("hardwareInventory", {}).get("evidenceDigest"), "release hardware evidence digest drifted")

    result = deepcopy(manifest)
    result["status"] = "materialized-candidate"
    result["buildContract"]["rootfsManifestDigest"] = rootfs_digest
    result["buildContract"]["trustedMediaImageDigest"] = release["trustedMediaImageDigest"]
    result["buildContract"]["twoIndependentBuildDigests"] = list(builds)
    result["buildContract"]["observedGstreamerElements"] = list(observed)
    result["buildContract"]["observedForbiddenGstreamerElements"] = []
    result["services"]["trustedMedia"]["imageDigest"] = release["trustedMediaImageDigest"]
    selection = result["services"]["trustedMedia"]["deviceSelection"]
    require(selected_hdmi_playback in selection["hdmiPlaybackAllowlist"], "HDMI playback device is outside the reviewed allowlist")
    selection["selectedHdmiPlayback"] = selected_hdmi_playback
    allowed_devices = {
        item["path"]: item for item in result["services"]["trustedMedia"]["deviceAllowlist"]
    }
    result["services"]["trustedMedia"]["devices"] = [
        deepcopy(allowed_devices[path])
        for path in [*selection["fixed"], selected_hdmi_playback]
    ]
    result["services"]["internalSfu"]["user"] = sfu_user
    result["services"]["internalSfu"]["network"]["rtcTcp"]["hostAddress"] = str(address)
    result["services"]["internalSfu"]["network"]["rtcUdp"]["hostAddress"] = str(address)
    result["activationGate"] = {"materialized": True, "currentBlockers": []}
    result["materializedRelease"] = dict(release)
    return result


def _secret_key_present(value: object, forbidden: set[str]) -> bool:
    if isinstance(value, Mapping):
        for key, item in value.items():
            normalized = re.sub(r"[^a-z0-9]", "", str(key).lower())
            if normalized in forbidden or _secret_key_present(item, forbidden):
                return True
    elif isinstance(value, list):
        return any(_secret_key_present(item, forbidden) for item in value)
    return False


def validate_health_snapshot(
    snapshot: Mapping[str, object],
    *,
    release: Mapping[str, object],
    manifest: Mapping[str, object],
) -> dict[str, object]:
    """Validate a sanitized idle/active release-set readiness snapshot."""

    require(set(snapshot) == HEALTH_KEYS, "health snapshot fields are not exact")
    forbidden = {re.sub(r"[^a-z0-9]", "", item.lower()) for item in manifest["healthContract"]["forbiddenFields"]}
    require(not _secret_key_present(snapshot, forbidden), "health snapshot contains a secret or media field")
    require(snapshot.get("schemaVersion") == 1, "health snapshot schema drifted")
    for key in ("releaseId", "trustedMediaImageDigest", "sfuImageDigest"):
        require(snapshot.get(key) == release.get(key), f"health snapshot {key} drifted")
    reservation = manifest["reservation"]
    session_reservation = manifest["sessionReservation"]
    require(snapshot.get("serviceReservationProfileDigest") == canonical_digest(reservation), "health service reservation digest drifted")
    require(snapshot.get("sessionReservationProfileDigest") == canonical_digest(session_reservation), "health session reservation digest drifted")
    require(snapshot.get("serviceReservationActive") is True, "trusted-media service reservation is not active")
    require(snapshot.get("supervisorReady") is True, "media supervisor is not ready")
    require(snapshot.get("ephemeralStateOnTmpfs") is True, "ephemeral receiver state is not on tmpfs")
    selected = snapshot.get("selectedSinks")
    require(isinstance(selected, list) and len(selected) == len(set(selected)) and set(selected) <= {"hdmi", "browser"}, "selected sink set is invalid")
    sink_health = snapshot.get("sinkHealth")
    require(isinstance(sink_health, Mapping) and set(sink_health) == {"hdmi", "browser"}, "sink health fields are not exact")
    require(all(value in {"ready", "not-selected"} for value in sink_health.values()), "sink health contains an invalid state")
    viewer_count = snapshot.get("viewerCount")
    require(type(viewer_count) is int and viewer_count >= 0, "viewer count is invalid")
    phase = snapshot.get("phase")
    require(phase in {"idle", "active"}, "health phase is invalid")
    if phase == "idle":
        require(snapshot.get("sessionReservationActive") is False, "idle service retains a media session reservation")
        require(snapshot.get("sfuReady") is True, "idle SFU is not ready")
        require(snapshot.get("receiverRunning") is False and snapshot.get("mdnsAdvertised") is False, "idle service is receiving or advertising")
        require(selected == [] and sink_health == {"hdmi": "not-selected", "browser": "not-selected"}, "idle service owns an output sink")
        require(snapshot.get("publisherEncodeRenditions") == 0 and viewer_count == 0, "idle service retains browser media state")
    else:
        require(snapshot.get("sessionReservationActive") is True, "active receiver has no media session reservation")
        require(selected, "active receiver has no selected output")
        require(snapshot.get("receiverRunning") is True and snapshot.get("mdnsAdvertised") is True, "active receiver is not running and advertised")
        for sink in ("hdmi", "browser"):
            require(sink_health.get(sink) == ("ready" if sink in selected else "not-selected"), f"{sink} health does not match selection")
        if "browser" in selected:
            require(snapshot.get("sfuReady") is True, "browser output has no healthy SFU")
            require(snapshot.get("publisherEncodeRenditions") == 1, "browser output is not one publisher rendition")
        else:
            require(snapshot.get("publisherEncodeRenditions") == 0 and viewer_count == 0, "HDMI-only health retains browser media")
    return {"valid": True, "phase": phase, "selectedSinks": list(selected), "viewerCount": viewer_count}


class NarrowNodeAgent(Protocol):
    """Only the exact trusted-media release operations are available."""

    def acquire_reservation(self, release: Mapping[str, object], reservation: Mapping[str, object]) -> None: ...
    def start_sfu(self, release: Mapping[str, object], service: Mapping[str, object]) -> None: ...
    def start_trusted_media(self, release: Mapping[str, object], service: Mapping[str, object]) -> None: ...
    def wait_release_set_health(self, release: Mapping[str, object], timeout_seconds: int) -> Mapping[str, object]: ...
    def withdraw_discovery(self, release: Mapping[str, object]) -> None: ...
    def stop_trusted_media(self, release: Mapping[str, object]) -> None: ...
    def stop_sfu(self, release: Mapping[str, object]) -> None: ...
    def clear_ephemeral_state(self, release: Mapping[str, object]) -> None: ...
    def release_reservation(self, release: Mapping[str, object], reservation: Mapping[str, object]) -> None: ...
    def remove_trusted_media(self, release: Mapping[str, object]) -> None: ...
    def remove_sfu(self, release: Mapping[str, object]) -> None: ...


class TrustedMediaRuntimeOrchestrator:
    """RuntimeAdapter implementation for ``MediaReleaseController``."""

    def __init__(
        self,
        *,
        node_agent: NarrowNodeAgent,
        manifest_factory: Callable[[Mapping[str, object]], Mapping[str, object]],
    ) -> None:
        self._node_agent = node_agent
        self._manifest_factory = manifest_factory
        self._manifests: dict[str, Mapping[str, object]] = {}

    @staticmethod
    def _release_key(release: Mapping[str, object]) -> str:
        return canonical_digest(dict(release))

    def _manifest(self, release: Mapping[str, object]) -> Mapping[str, object]:
        key = self._release_key(release)
        if key not in self._manifests:
            manifest = self._manifest_factory(release)
            require(manifest.get("status") == "materialized-candidate", "runtime manifest is not materialized")
            require(manifest.get("activationGate") == {"materialized": True, "currentBlockers": []}, "runtime manifest remains blocked")
            require(manifest.get("materializedRelease") == dict(release), "runtime manifest release identity drifted")
            require(manifest.get("services", {}).get("trustedMedia", {}).get("imageDigest") == release.get("trustedMediaImageDigest"), "runtime manifest image drifted")
            require(manifest.get("services", {}).get("internalSfu", {}).get("imageDigest") == release.get("sfuImageDigest"), "runtime manifest SFU image drifted")
            require(manifest.get("buildContract", {}).get("rootfsManifestDigest") == release.get("rootfsManifestDigest"), "runtime manifest rootfs drifted")
            self._manifests[key] = deepcopy(manifest)
        return self._manifests[key]

    def start(self, release: Mapping[str, object]) -> None:
        manifest = self._manifest(release)
        reservation = manifest["reservation"]
        reserved = sfu_start_attempted = media_start_attempted = False
        try:
            self._node_agent.acquire_reservation(release, reservation)
            reserved = True
            sfu_start_attempted = True
            self._node_agent.start_sfu(release, manifest["services"]["internalSfu"])
            media_start_attempted = True
            self._node_agent.start_trusted_media(release, manifest["services"]["trustedMedia"])
        except BaseException:
            cleanup = []
            if media_start_attempted:
                cleanup.append(lambda: self._node_agent.stop_trusted_media(release))
            if sfu_start_attempted:
                cleanup.append(lambda: self._node_agent.stop_sfu(release))
            cleanup.append(lambda: self._node_agent.clear_ephemeral_state(release))
            if reserved:
                cleanup.append(lambda: self._node_agent.release_reservation(release, reservation))
            for operation in cleanup:
                try:
                    operation()
                except Exception:
                    # The lifecycle journal remains authoritative and retries
                    # the same idempotent cleanup through ``_quiesce``.
                    pass
            raise

    def wait_healthy(self, release: Mapping[str, object], timeout_seconds: int) -> bool:
        manifest = self._manifest(release)
        try:
            snapshot = self._node_agent.wait_release_set_health(release, timeout_seconds)
            validate_health_snapshot(snapshot, release=release, manifest=manifest)
        except Exception:
            return False
        return True

    def withdraw_discovery(self, release: Mapping[str, object]) -> None:
        self._node_agent.withdraw_discovery(release)

    def stop(self, release: Mapping[str, object]) -> None:
        failure: Exception | None = None
        for operation in (self._node_agent.stop_trusted_media, self._node_agent.stop_sfu):
            try:
                operation(release)
            except Exception as error:
                if failure is None:
                    failure = error
        if failure is not None:
            raise failure

    def clear_ephemeral_state(self, release: Mapping[str, object]) -> None:
        manifest = self._manifest(release)
        try:
            self._node_agent.clear_ephemeral_state(release)
        finally:
            self._node_agent.release_reservation(release, manifest["reservation"])

    def remove(self, release: Mapping[str, object]) -> None:
        failure: Exception | None = None
        try:
            for operation in (self._node_agent.remove_trusted_media, self._node_agent.remove_sfu):
                try:
                    operation(release)
                except Exception as error:
                    if failure is None:
                        failure = error
        finally:
            self._manifests.pop(self._release_key(release), None)
        if failure is not None:
            raise failure
