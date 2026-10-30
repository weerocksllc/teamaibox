#!/usr/bin/env python3
"""Validate the fail-closed AirPlay-compatible source review packet."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Mapping


ROOT = Path(__file__).resolve().parents[1]
REVIEW_V1 = ROOT / "architecture/validation/airplay-compatible-supply-chain-review.v1.json"
REVIEW_V2 = ROOT / "architecture/validation/airplay-compatible-supply-chain-review.v2.json"
REVIEW = ROOT / "architecture/validation/airplay-compatible-supply-chain-review.v3.json"
APPROVAL_RECORD = ROOT / "docs/operations/airplay-compatible-human-approval.v2.md"
SCOPE_DECISION = ROOT / "docs/operations/airplay-compatible-open-source-release-minimum.v3.md"
LOCK = ROOT / "deploy/casting/airplay-compatible-stack.lock.json"
SHA1 = re.compile(r"[a-f0-9]{40}")
SHA256 = re.compile(r"sha256:[a-f0-9]{64}")

PRODUCT_COPY_EN = "AirPlay-compatible wireless casting (not Apple-certified)"
PRODUCT_COPY_ZH = "兼容 AirPlay 的无线投屏（非 Apple 认证）"
DRM_COPY_EN = "FairPlay/DRM-protected content is unsupported."
DRM_COPY_ZH = "不支持受 FairPlay/DRM 保护的内容。"

EXPECTED_COMPONENTS = {
    "GStreamer monorepo": ("1.28.6", "2d3e05cbdad68e47d645f548899b432dc9fb4473"),
    "gst-plugins-rs gst-plugin-webrtc": ("0.15.3", "75e46c3a1b868e9a08fd688d091476b76a498df1"),
    "LiveKit server": ("1.13.6", "3cfbd1242618a61178f7a05b126d6c0c4cac3731"),
    "LiveKit browser client": ("2.21.0", "15ca5f8180ab8939c3a5a4dfee1d5e44f62f71cf"),
    "GLib": ("2.88.3", "43bc79ea8803e33c5eb368085e2d5906f9f98079"),
    "libplist": ("2.7.0", "cf5897a71ea412ea2aeb1e2f6b5ea74d4fabfd8c"),
    "OpenSSL": ("3.5.8", "f4dc4d58b48d346a8270183f89acf826d459b0ca"),
    "Avahi": ("0.8", "f060abee2807c943821d88839c013ce15db17b58"),
    "FFmpeg": ("8.1.2", "38b88335f99e76ed89ff3c93f877fdefce736c13"),
    "libnice": ("0.1.24", "af62014d520ac09c8fe1974bda1b253114c68843"),
    "libsrtp": ("2.8.0", "24b3bf8f19b6f5ab4cd2bcceb4f4064efca86fd5"),
    "usrsctp": ("0.9.5.0", "07f871bda23943c43c9e74cc54f25130459de830"),
    "libvpx": ("1.17.0", "6df3ec34557879fff673706f4a1d9fbd0f3a6f0e"),
    "Opus": ("1.6.1", "22244de5a79bd1d6d623c32e72bf1954b56235be"),
    "nv-codec-headers": ("13.0.19.1", "88fee5c37318c991a8762d423530f91681e32e3a"),
}

EXPECTED_LICENSES = {
    "GStreamer monorepo": "LGPL-2.1-or-later",
    "gst-plugins-rs gst-plugin-webrtc": "MPL-2.0",
    "LiveKit server": "Apache-2.0",
    "LiveKit browser client": "Apache-2.0",
    "GLib": "LGPL-2.1-or-later",
    "libplist": "LGPL-2.1-or-later",
    "OpenSSL": "Apache-2.0",
    "Avahi": "LGPL-2.1-or-later",
    "FFmpeg": "LGPL-2.1-or-later",
    "libnice": "LGPL-2.1-or-later OR MPL-1.1",
    "libsrtp": "BSD-3-Clause",
    "usrsctp": "BSD-3-Clause",
    "libvpx": "BSD-3-Clause",
    "Opus": "BSD-3-Clause",
    "nv-codec-headers": "MIT",
}

REQUIRED_FORBIDDEN_FEATURES = {
    "gst-plugins-ugly",
    "x264",
    "x265",
    "OpenH264",
    "fdk-aac",
    "FFmpeg --enable-gpl",
    "FFmpeg --enable-nonfree",
    "gst-plugin-webrtc default features",
    "gst-plugin-webrtc aws",
    "gst-plugin-webrtc janus",
    "gst-plugin-webrtc whip",
    "gst-plugin-webrtc whep",
    "gst-plugin-webrtc web_server",
}

REQUIRED_HUMAN_DECISIONS = {
    "uxplay-playfair-inherited-code-and-territorial-legality",
    "apple-mfi-trademark-copy-and-attribution",
    "h264-aac-alac-vp8-opus-and-nvidia-patent-clearance",
    "gplv3-lgpl-mpl-appliance-distribution-plan",
    "final-sbom-signature-provenance-vulnerability-and-source-mirror-acceptance",
}

EXPECTED_HUMAN_DECISION_EFFECTS = {
    "uxplay-playfair-inherited-code-and-territorial-legality": "accountable-project-responsibility-accepted",
    "apple-mfi-trademark-copy-and-attribution": "approved-only-with-locked-non-certification-wording",
    "h264-aac-alac-vp8-opus-and-nvidia-patent-clearance": "accountable-project-responsibility-accepted",
    "gplv3-lgpl-mpl-appliance-distribution-plan": "locked-compliance-plan-approved",
    "final-sbom-signature-provenance-vulnerability-and-source-mirror-acceptance": "accountable-final-review-responsibility-accepted-artifacts-still-required",
}

REMAINING_AUTOMATED_GATES = {
    "controlled-source-archives-and-mirrors-verified",
    "upstream-signature-identities-or-internal-mirror-attestations-verified",
    "complete-file-level-and-transitive-license-closure-verified",
    "final-arm64-receiver-and-sfu-image-digests-locked",
    "complete-spdx-and-cyclonedx-sboms-reconciled",
    "final-image-signatures-and-slsa-provenance-verified",
    "fresh-vulnerability-evidence-accepted",
    "two-independent-arm64-build-digests-match",
    "real-device-authentication-encryption-and-drm-refusal-verified",
}

MANDATORY_OPEN_SOURCE_GATES = {
    "exact-direct-source-revisions-and-sha256-verified",
    "applicable-license-and-notice-material-shipped",
    "corresponding-source-modifications-and-build-instructions-published",
    "final-arm64-image-spdx-json-sbom-generated",
    "no-unaccepted-critical-vulnerability",
    "final-oci-digest-and-teamaibox-signature-verified",
}

OPTIONAL_ASSURANCE = {
    "dedicated-private-source-mirror",
    "airplay-specific-slsa-provenance",
    "cyclonedx-duplicate-sbom",
    "two-byte-identical-independent-builds",
}

APPROVAL_STATEMENT = "AirPlay 还有 5 项许可证、商标、专利和分发责任需要人工批准； ---已经批准了。"

REQUIRED_UXPLAY_OPTIONS = {
    "-rc /dev/null",
    "-nh",
    "-m",
    "-s 1920x1080",
    "-fps 30",
    "-pin",
    "-reg /run/teamaibox/uxplay.register",
    "-key /run/teamaibox/uxplay.pem",
}

FORBIDDEN_UXPLAY_OPTIONS = {
    "-pw",
    "-nohold",
    "-hls",
    "-mp4",
    "-h265",
    "-vdmp",
    "-admp",
    "-dacp",
    "-ca",
    "-md",
    "-ble",
    "-scrsv",
}

ALLOWED_DYNAMIC_UXPLAY_OPTIONS = {
    "-n": "session-random-ascii-name-without-user-team-host-or-device-identity",
    "-vs": "supervisor-owned-fixed-gstreamer-video-pipeline",
    "-as": "supervisor-owned-fixed-gstreamer-audio-pipeline",
}


def digest_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def component_map(lock: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    components = lock.get("components")
    require(isinstance(components, list), "component list is missing")
    result: dict[str, Mapping[str, Any]] = {}
    for component in components:
        require(isinstance(component, Mapping), "component entry is not an object")
        name = component.get("name")
        require(isinstance(name, str) and name not in result, "component name is missing or duplicated")
        result[name] = component
    return result


def validate_lock(lock: Mapping[str, Any]) -> dict[str, Any]:
    require(lock.get("schemaVersion") == 1, "source lock schema drifted")
    require(lock.get("lockId") == "teamaibox.airplay-compatible-stack.candidate.v1", "source lock identity drifted")
    require(lock.get("asOf") == "2026-09-04", "source lock review date drifted")

    target = lock.get("target")
    require(isinstance(target, Mapping) and target.get("platform") == "linux/arm64/v8", "source lock ARM64 target drifted")
    require(target.get("phase") == "source-candidate-only" and target.get("remoteDeploymentPerformed") is False, "source packet claims deployment")
    require(target.get("releaseEligible") is False and target.get("task22_1Complete") is False, "source packet improperly completes 22.1")

    receiver = lock.get("receiver")
    require(isinstance(receiver, Mapping), "UxPlay receiver record is missing")
    require(receiver.get("version") == "1.73.6" and receiver.get("tag") == "v1.73.6", "UxPlay version drifted")
    require(receiver.get("commitSha1") == "21eef8df25d91e12635c36d8176ad192725baca2", "UxPlay commit drifted")
    require(receiver.get("treeSha1") == "ece31de373433cf042ecb3ab801abb6ceb23fba3", "UxPlay tree drifted")
    require(receiver.get("tagSignatureState") == "unsigned-lightweight", "UxPlay unsigned tag boundary drifted")
    require(receiver.get("sourceArchiveSha256") is None and receiver.get("sourceMirrorVerified") is False, "UxPlay source is incorrectly marked verified")
    license_record = receiver.get("license")
    require(isinstance(license_record, Mapping) and license_record.get("expression") == "GPL-3.0-only", "UxPlay GPLv3 record drifted")
    require(SHA256.fullmatch(str(license_record.get("fileSha256", ""))) is not None, "UxPlay license digest is invalid")
    bundled = receiver.get("bundledCode")
    require(isinstance(bundled, list), "UxPlay bundled-code inventory is missing")
    bundled_by_name = {item.get("name"): item for item in bundled if isinstance(item, Mapping)}
    playfair = bundled_by_name.get("PlayFair")
    require(isinstance(playfair, Mapping) and playfair.get("humanLegalReviewRequired") is True, "PlayFair legal gate is missing")
    require(playfair.get("provenanceStatus") == "upstream-declares-legal-status-unclear", "PlayFair upstream warning drifted")
    inherited = bundled_by_name.get("inherited RPiPlay, ShairPlay and AirplayServer code")
    require(isinstance(inherited, Mapping) and inherited.get("fileLevelMappingComplete") is False, "inherited-code provenance is improperly complete")

    components = component_map(lock)
    require(set(components) == set(EXPECTED_COMPONENTS), "exact component closure drifted")
    for name, (version, commit) in EXPECTED_COMPONENTS.items():
        component = components[name]
        require(component.get("version") == version, f"{name} version drifted")
        require(component.get("commitSha1") == commit and SHA1.fullmatch(commit) is not None, f"{name} commit drifted")
        require(component.get("licenseExpression") == EXPECTED_LICENSES[name], f"{name} license expression drifted")
        license_digest = component.get("licenseFileSha256")
        if name != "nv-codec-headers":
            require(SHA256.fullmatch(str(license_digest or "")) is not None, f"{name} license digest is missing")

    nv_headers = components["nv-codec-headers"]
    require(
        nv_headers.get("licenseBearingHeaderSha256")
        == "sha256:8776fddcb8febc6aec4d73989b1f21831eb30306bc583da55b4bf0c14a1dc228",
        "nv-codec-headers license-bearing header digest drifted",
    )

    gstreamer = components["GStreamer monorepo"]
    require(set(gstreamer.get("selectedSubprojects", [])) == {"gstreamer", "gst-plugins-base", "gst-plugins-good", "gst-plugins-bad", "gst-libav"}, "GStreamer subproject allowlist drifted")
    required_elements = {"h264parse", "nvh264dec", "webrtcbin", "vp8enc", "opusenc", "avdec_aac", "avdec_alac", "avdec_h264"}
    require(required_elements.issubset(set(gstreamer.get("selectedRuntimeElements", []))), "GStreamer runtime element allowlist is incomplete")

    webrtc = components["gst-plugins-rs gst-plugin-webrtc"]
    require(webrtc.get("defaultFeatures") is False and webrtc.get("enabledFeatures") == ["livekit"], "gst-plugin-webrtc feature closure drifted")
    require(webrtc.get("cargoLocked") is True and webrtc.get("selectedElements") == ["livekitwebrtcsink"], "LiveKit producer lock is incomplete")

    livekit = components["LiveKit server"]
    require(livekit.get("arm64Image") == "docker.io/livekit/livekit-server@sha256:4eeb7a7af9e133afee7d07fc48623373852a34ad709094345d1761c9b283dc1a", "LiveKit ARM64 image digest drifted")
    require(livekit.get("observedOciRevisionMatchesCommit") is True and livekit.get("provenanceAttestationObserved") is True, "LiveKit registry provenance observation is incomplete")
    require(livekit.get("sbomAttestationObserved") is False and livekit.get("signatureVerified") is False, "LiveKit is improperly marked supply-chain approved")

    browser_client = components["LiveKit browser client"]
    require(browser_client.get("tag") == "v2.21.0"
            and browser_client.get("tagObjectSha1") == "b91e3bb64365a822b0200c4bb38535a314628479"
            and browser_client.get("tagSignatureState") == "unsigned-annotated"
            and browser_client.get("commitSignatureState") == "github-pgp-verified",
            "LiveKit browser-client Git identity drifted")
    require(browser_client.get("npmPackage") == "livekit-client"
            and browser_client.get("npmTarballSha1") == "694bee97e7e37594a7fabbb1c69e84699d6cc0ce"
            and browser_client.get("npmIntegrity") == "sha512-RBUhPkV/sl1nzl8lokVlK5uATPwn0AlsudCBZXissw/kDl9yz8ac4pNJ43iPpMVoHOeBYH/BZ3vUC1adqa/zFQ=="
            and browser_client.get("npmSignatureObserved") is True
            and browser_client.get("npmProvenanceAttestationObserved") is True,
            "LiveKit browser-client registry identity drifted")
    require(browser_client.get("controlledTarballSha256") is None
            and browser_client.get("controlledTarballVerified") is False
            and browser_client.get("transitiveBrowserBundleReviewed") is False,
            "LiveKit browser client is improperly marked release verified")

    ffmpeg = components["FFmpeg"]
    require(ffmpeg.get("configurePolicy") == [
        "--disable-gpl", "--disable-nonfree", "--disable-programs", "--disable-doc",
        "--disable-everything", "--enable-avcodec", "--enable-avutil",
        "--enable-decoder=h264,aac,alac", "--enable-parser=h264,aac",
    ], "FFmpeg allowlist drifted")

    pipeline = lock.get("pipelinePolicy")
    require(isinstance(pipeline, Mapping), "pipeline policy is missing")
    ingress = pipeline.get("airPlayIngress")
    egress = pipeline.get("browserEgress")
    require(isinstance(ingress, Mapping) and ingress.get("hevcEnabled") is False and ingress.get("hlsEnabled") is False and ingress.get("recordingEnabled") is False, "ingress expands beyond reviewed codecs")
    require(isinstance(egress, Mapping) and egress.get("video") == "VP8" and egress.get("audio") == "Opus", "browser codec selection drifted")
    require(egress.get("onePublisherEncode") is True and egress.get("sfuFanout") == "LiveKit"
            and egress.get("browserClient") == "LiveKit browser client 2.21.0"
            and egress.get("maximumViewers") == 8, "SFU fanout policy drifted")
    require(egress.get("h264EncodeEnabled") is False, "unreviewed H.264 browser encoding is enabled")
    require(set(pipeline.get("forbiddenBuildFeatures", [])) == REQUIRED_FORBIDDEN_FEATURES, "forbidden codec/plugin policy drifted")
    auth = pipeline.get("sessionAuthentication")
    require(isinstance(auth, Mapping), "session authentication policy is missing")
    require(set(auth.get("requiredOptions", [])) == REQUIRED_UXPLAY_OPTIONS, "exact fixed UxPlay option allowlist drifted")
    dynamic = auth.get("allowedDynamicOptions")
    require(isinstance(dynamic, list), "dynamic UxPlay option allowlist is missing")
    require(
        len(dynamic) == len(ALLOWED_DYNAMIC_UXPLAY_OPTIONS)
        and all(isinstance(item, Mapping) and set(item) == {"option", "valuePolicy"} for item in dynamic)
        and
        {item.get("option"): item.get("valuePolicy") for item in dynamic if isinstance(item, Mapping)}
        == ALLOWED_DYNAMIC_UXPLAY_OPTIONS,
        "dynamic UxPlay option allowlist drifted",
    )
    require(set(auth.get("forbiddenOptions", [])) == FORBIDDEN_UXPLAY_OPTIONS, "forbidden UxPlay privacy/protocol options drifted")
    require(
        auth.get("exactOptionAllowlistRequired") is True
        and auth.get("inheritedConfigurationFilesAllowed") is False
        and auth.get("uxplayrcEnvironmentAllowed") is False,
        "UxPlay startup configuration can bypass the exact option allowlist",
    )
    require(auth.get("registerAndKeyOnTmpfs") is True and auth.get("stateDestroyedAtSessionEnd") is True, "session trust state is not ephemeral")
    require(auth.get("authenticatedEncryptedProtocolStillRequiresRealDeviceProof") is True, "real-device security gate is missing")

    boundary = lock.get("legalBoundary")
    require(isinstance(boundary, Mapping), "legal copy boundary is missing")
    require(boundary.get("productCopyEnglish") == PRODUCT_COPY_EN and boundary.get("productCopyChinese") == PRODUCT_COPY_ZH, "AirPlay-compatible product copy drifted")
    require(boundary.get("fairPlayBoundaryEnglish") == DRM_COPY_EN and boundary.get("fairPlayBoundaryChinese") == DRM_COPY_ZH, "FairPlay/DRM boundary drifted")
    for field in ("appleAuthorizationPresent", "mfiMembershipOrCertificationPresent", "appleLogoOrBadgeAllowed", "playFairLegalityApproved", "codecPatentClearanceApproved"):
        require(boundary.get(field) is False, f"pending legal boundary {field} is improperly approved")

    verification = lock.get("verificationPolicy")
    require(isinstance(verification, Mapping), "verification policy is missing")
    expected_tools = {
        "syft": ("1.50.0", "docker.io/anchore/syft@sha256:142a0f42f34a4bef64c15e1720c504ff3f2840ae6ce4d5bfd2b26948cbfac82a"),
        "cosign": ("3.0.6", "ghcr.io/sigstore/cosign/cosign@sha256:fbc7abb42803effc0467e06d612f4e5fa37f68b54c4733c312b021a150519b43"),
        "grype": ("0.118.0", "docker.io/anchore/grype@sha256:84a1e5435228172a0e56e8bfda49fa7ca62159f5eefcf7ae4b7851952e72315f"),
    }
    tools = verification.get("tools")
    require(isinstance(tools, Mapping) and set(tools) == set(expected_tools), "verification tool lock drifted")
    for name, (version, image) in expected_tools.items():
        require(tools[name] == {"version": version, "arm64Image": image}, f"{name} identity drifted")
    for field in (
        "sourceSignaturesVerified", "builtImageSbomVerified", "builtImageSignatureVerified",
        "builtImageProvenanceVerified", "builtImageVulnerabilitiesAccepted",
        "reproducibleArm64DigestVerified",
    ):
        require(verification.get(field) is False, f"unexecuted verification {field} is marked complete")
    require(verification.get("requiredSbomFormat") == "spdx-json" and verification.get("criticalFindingsAllowed") == 0, "SBOM/vulnerability policy drifted")

    closure = lock.get("closure")
    require(isinstance(closure, Mapping) and closure.get("topLevelCandidatePinsComplete") is True, "candidate pin closure is missing")
    require(closure.get("transitiveBuildClosureComplete") is False and closure.get("releaseBlocked") is True and closure.get("task22_1Complete") is False, "source candidate improperly claims release closure")
    require(len(closure.get("missingBeforeRelease", [])) >= 10, "release gap inventory is incomplete")

    return {"componentCount": len(components), "lockId": lock["lockId"]}


def local_artifact(record: Mapping[str, Any]) -> Path:
    relative = record.get("path")
    require(isinstance(relative, str) and relative, "release artifact path is missing")
    result = (ROOT / relative).resolve()
    require(ROOT in result.parents and result.is_file(), f"release artifact is missing: {relative}")
    require(record.get("fileSha256") == digest_bytes(result.read_bytes()), f"release artifact digest drifted: {relative}")
    return result


def validate_predecessor(path: Path = REVIEW_V1) -> dict[str, Any]:
    review = json.loads(path.read_text(encoding="utf-8"))
    require(review.get("schemaVersion") == 1 and review.get("reviewId") == "teamaibox.airplay-compatible-supply-chain-review.v1", "review identity drifted")
    require(review.get("asOf") == "2026-09-04", "review date drifted")

    artifacts = review.get("releaseArtifacts")
    require(isinstance(artifacts, Mapping) and set(artifacts) == {"sourceLock", "reviewGuide", "noticeTemplate"}, "release artifact map drifted")
    lock_path = local_artifact(artifacts["sourceLock"])
    guide_path = local_artifact(artifacts["reviewGuide"])
    notice_path = local_artifact(artifacts["noticeTemplate"])
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    lock_summary = validate_lock(lock)

    subject = review.get("subject")
    require(isinstance(subject, Mapping), "review subject is missing")
    require(subject.get("sourceLock") == "deploy/casting/airplay-compatible-stack.lock.json", "review source-lock path drifted")
    require(subject.get("sourceLockSha256") == digest_bytes(lock_path.read_bytes()), "review source-lock digest drifted")
    require(subject.get("platform") == "linux/arm64/v8", "review ARM64 subject drifted")
    require(subject.get("receiver") == {
        "name": "UxPlay", "version": "1.73.6",
        "commitSha1": "21eef8df25d91e12635c36d8176ad192725baca2",
        "treeSha1": "ece31de373433cf042ecb3ab801abb6ceb23fba3",
    }, "review UxPlay subject drifted")
    require(subject.get("browserViewer") == {
        "name": "LiveKit browser client", "version": "2.21.0",
        "commitSha1": "15ca5f8180ab8939c3a5a4dfee1d5e44f62f71cf",
        "npmTarballSha1": "694bee97e7e37594a7fabbb1c69e84699d6cc0ce",
    }, "review LiveKit browser-client subject drifted")

    sources = review.get("authoritativeSources")
    require(isinstance(sources, list) and len(sources) >= 8, "authoritative primary-source list is incomplete")
    urls = {item.get("url") for item in sources if isinstance(item, Mapping)}
    for domain in ("github.com/FDH2/UxPlay", "gitlab.freedesktop.org/gstreamer", "github.com/livekit/livekit",
                   "github.com/livekit/client-sdk-js", "registry.npmjs.org/livekit-client",
                   "apple.com/legal", "mfi.apple.com", "developer.apple.com/streaming/fps"):
        require(any(domain in str(url) for url in urls), f"authoritative source missing: {domain}")

    findings = review.get("engineeringFindings")
    require(isinstance(findings, Mapping), "engineering findings are missing")
    for field in ("uxplayTagIsUnsignedLightweight", "playFairBundled", "playFairUpstreamLegalStatusDeclaredUnclear", "exactUxplayOptionAllowlistRecorded", "openSslAtLeast3SelectedForGplCompatibility", "livekitPublisherAndSeparateSfuSelected", "livekitBrowserClientPinned", "livekitBrowserClientCommitSignatureVerified", "livekitBrowserClientNpmProvenanceAttestationObserved"):
        require(findings.get(field) is True, f"engineering finding is missing: {field}")
    for field in ("inheritedCodeFileLevelLicenseMapComplete", "livekitUpstreamSbomAttestationObserved", "livekitSignatureVerified", "livekitBrowserClientControlledTarballVerified", "livekitBrowserClientTransitiveBundleReviewed", "everyBundledLibraryReviewed", "completeTransitiveSbomAvailable", "arm64ReceiverBuilt", "arm64HardwareCompatibilityVerified"):
        require(findings.get(field) is False, f"pending engineering finding is improperly complete: {field}")
    require(findings.get("airplayIngressCodecs") == ["H.264", "AAC", "ALAC"] and findings.get("browserEgressCodecs") == ["VP8", "Opus"], "review codec scope drifted")
    require(findings.get("fairPlayDrmProtectedContentSupported") is False, "review claims DRM support")

    distribution = review.get("distributionCompliancePlan")
    require(isinstance(distribution, Mapping), "distribution compliance plan is missing")
    for field in ("treatReceiverAggregateAsGplv3", "completeCorrespondingSourceRequired", "modificationNoticesRequired", "gplSection6DeliveryMethodRequired", "installationInformationAnalysisRequired", "noFurtherRestrictionsReviewRequired", "lgplDynamicLinkingRequired", "lgplReplacementOrRelinkPathRequired", "mplCoveredFileSourceRequired", "allLicenseNoticeAndPatentFilesRequired"):
        require(distribution.get(field) is True, f"distribution safeguard is missing: {field}")
    require(distribution.get("staticLgplLinkingAllowed") is False and distribution.get("counselApproved") is False, "distribution plan is improperly approved")

    copy_policy = review.get("trademarkAndDrmPolicy")
    require(isinstance(copy_policy, Mapping), "trademark/DRM policy is missing")
    require(copy_policy.get("productCopyEnglish") == PRODUCT_COPY_EN and copy_policy.get("productCopyChinese") == PRODUCT_COPY_ZH, "review product copy drifted")
    require(copy_policy.get("fairPlayBoundaryEnglish") == DRM_COPY_EN and copy_policy.get("fairPlayBoundaryChinese") == DRM_COPY_ZH, "review DRM copy drifted")
    for field in ("appleLogoAllowed", "airplayOrMfiBadgeAllowed", "appleCertifiedClaimAllowed", "mfiCertifiedClaimAllowed"):
        require(copy_policy.get(field) is False, f"Apple claim safeguard drifted: {field}")
    require(copy_policy.get("finalTrademarkAttributionPendingCounsel") is True, "trademark counsel gate is missing")

    require(set(review.get("requiredHumanDecisions", [])) == REQUIRED_HUMAN_DECISIONS, "human legal decision list drifted")
    verification = review.get("verificationState")
    require(isinstance(verification, Mapping), "verification state is missing")
    for field in ("sourceCandidatePinsRecorded", "forbiddenCodecAndPluginPolicyRecorded", "gplDistributionChecklistPrepared", "appleAndDrmCopyPrepared"):
        require(verification.get(field) is True, f"source review preparation is incomplete: {field}")
    for field in ("controlledSourceArchivesVerified", "upstreamSignaturesVerified", "finalArm64ImageDigestsLocked", "completeSpdxSbomsVerified", "completeCycloneDxSbomsVerified", "finalImageSignaturesVerified", "finalSlsaProvenanceVerified", "freshVulnerabilityEvidenceAccepted", "twoBuildReproducibilityVerified", "realDeviceSecurityBoundaryVerified"):
        require(verification.get(field) is False, f"unexecuted review verification is marked complete: {field}")

    decision = review.get("decision")
    require(isinstance(decision, Mapping) and decision.get("status") == "source-review-prepared-not-approved", "review is not pending approval")
    require(decision.get("reviewerAttestation") is None, "pending review has a reviewer attestation")
    for field in ("playFairAndProvenanceApproved", "appleMfiTrademarkApproved", "codecPatentClearanceApproved", "distributionPlanApproved", "releaseSupplyChainApproved", "releaseEligible"):
        require(decision.get(field) is False, f"pending decision is improperly approved: {field}")

    fail_closed = review.get("failClosed")
    require(isinstance(fail_closed, Mapping) and fail_closed.get("sourceResearchMayContinue") is True, "source-review allowance is missing")
    for field in ("remoteDeploymentBlockedByThisPacket", "releaseBuildBlocked", "receiverAdvertisementBlocked", "appleCertificationClaimBlocked", "fairPlayDrmAttemptBlocked"):
        require(fail_closed.get(field) is True, f"fail-closed safeguard is missing: {field}")
    require(fail_closed.get("task22_1Complete") is False, "review improperly completes OpenSpec 22.1")

    guide = guide_path.read_text(encoding="utf-8")
    for phrase in (
        "not legal advice", "OpenSpec 22.1 must remain unchecked", "Complete Corresponding Source",
        "Installation Information", PRODUCT_COPY_EN, DRM_COPY_EN,
        "embedded-pgp-unverified",
    ):
        require(phrase in guide, f"review guide omits required boundary: {phrase}")
    notice = notice_path.read_text(encoding="utf-8")
    require(notice.startswith("DRAFT — NOT FOR RELEASE OR DISTRIBUTION"), "NOTICE template is not visibly draft")
    for phrase in (PRODUCT_COPY_EN, PRODUCT_COPY_ZH, DRM_COPY_EN, DRM_COPY_ZH, "Complete Corresponding Source", "[REQUIRED]", "[COUNSEL"):
        require(phrase in notice, f"NOTICE template omits required boundary: {phrase}")

    return {
        "valid": True,
        "reviewId": review["reviewId"],
        "lockId": lock_summary["lockId"],
        "componentCount": lock_summary["componentCount"],
        "releaseEligible": False,
        "task22_1Complete": False,
        "requiredHumanDecisionCount": len(REQUIRED_HUMAN_DECISIONS),
        "packetDigest": digest_bytes(path.read_bytes()),
    }


def validate_v2(path: Path = REVIEW_V2) -> dict[str, Any]:
    review = json.loads(path.read_text(encoding="utf-8"))
    require(
        review.get("schemaVersion") == 2
        and review.get("reviewId") == "teamaibox.airplay-compatible-supply-chain-review.v2",
        "approval review identity drifted",
    )
    require(review.get("asOf") == "2026-09-06", "approval review date drifted")

    predecessor = review.get("predecessor")
    require(isinstance(predecessor, Mapping), "approval predecessor is missing")
    require(
        predecessor.get("path") == "architecture/validation/airplay-compatible-supply-chain-review.v1.json"
        and predecessor.get("reviewId") == "teamaibox.airplay-compatible-supply-chain-review.v1",
        "approval predecessor identity drifted",
    )
    predecessor_path = (ROOT / str(predecessor["path"])).resolve()
    require(
        predecessor_path == REVIEW_V1.resolve()
        and predecessor.get("fileSha256") == digest_bytes(predecessor_path.read_bytes()),
        "approval predecessor digest drifted",
    )
    predecessor_result = validate_predecessor(predecessor_path)

    approval_record = review.get("approvalRecord")
    require(isinstance(approval_record, Mapping), "approval record is missing")
    require(
        approval_record.get("path") == "docs/operations/airplay-compatible-human-approval.v2.md"
        and APPROVAL_RECORD.is_file()
        and approval_record.get("fileSha256") == digest_bytes(APPROVAL_RECORD.read_bytes()),
        "approval record digest drifted",
    )
    approval_text = APPROVAL_RECORD.read_text(encoding="utf-8")
    for phrase in (
        APPROVAL_STATEMENT,
        "This clears the five accountable human decision gates",
        "OpenSpec 22.1 remains incomplete",
        PRODUCT_COPY_EN,
        DRM_COPY_EN,
        "not legal advice",
    ):
        require(phrase in approval_text, f"approval record omits required boundary: {phrase}")

    attestation = review.get("reviewerAttestation")
    require(isinstance(attestation, Mapping), "reviewer attestation is missing")
    require(
        attestation == {
            "authorityType": "requesting-project-authority",
            "captureChannel": "explicit-user-message-in-current-authenticated-codex-task",
            "recordedAt": "2026-09-06",
            "statement": APPROVAL_STATEMENT,
            "reviewerDisplayName": None,
            "externalSignature": None,
            "legalOpinionAttached": False,
        },
        "reviewer attestation drifted or fabricates unsupported identity",
    )

    decisions = review.get("humanDecisions")
    require(isinstance(decisions, list) and len(decisions) == 5, "human approval decision count drifted")
    decision_map: dict[str, Mapping[str, Any]] = {}
    for item in decisions:
        require(isinstance(item, Mapping), "human approval decision is not an object")
        decision_id = item.get("id")
        require(isinstance(decision_id, str) and decision_id not in decision_map, "human approval decision is missing or duplicated")
        decision_map[decision_id] = item
    require(set(decision_map) == REQUIRED_HUMAN_DECISIONS, "human approval decision set drifted")
    for decision_id, expected_effect in EXPECTED_HUMAN_DECISION_EFFECTS.items():
        item = decision_map[decision_id]
        require(
            set(item) == {"id", "approved", "effect"}
            and item.get("approved") is True
            and item.get("effect") == expected_effect,
            f"human approval decision is not exact: {decision_id}",
        )

    decision = review.get("decision")
    require(
        decision == {
            "status": "human-decisions-approved-automated-verification-pending",
            "requiredHumanDecisionCount": 5,
            "approvedHumanDecisionCount": 5,
            "pendingHumanDecisionCount": 0,
            "allRequiredHumanDecisionsApproved": True,
            "sourceMaterializationAuthorized": True,
            "localArm64BuildAuthorized": True,
            "automatedReleaseVerificationComplete": False,
            "releaseEligible": False,
            "task22_1Complete": False,
        },
        "approval decision or technical completion boundary drifted",
    )
    require(set(review.get("remainingAutomatedGates", [])) == REMAINING_AUTOMATED_GATES, "remaining automated gate set drifted")
    require(review.get("productBoundary") == {
        "productCopyEnglish": PRODUCT_COPY_EN,
        "productCopyChinese": PRODUCT_COPY_ZH,
        "appleLogoOrBadgeAllowed": False,
        "appleOrMfiCertificationClaimAllowed": False,
        "fairPlayDrmProtectedContentSupported": False,
    }, "approved product-copy or DRM boundary drifted")
    require(review.get("failClosed") == {
        "sourceResearchMayContinue": True,
        "controlledSourceMaterializationMayContinue": True,
        "localArm64BuildMayContinue": True,
        "remoteDeploymentBlockedUntilTechnicalSupplyChainPass": True,
        "releaseBlockedUntilTechnicalSupplyChainPass": True,
        "receiverAdvertisementBlockedUntilRealDeviceAcceptance": True,
        "task22_1Complete": False,
    }, "approval fail-closed boundary drifted")

    return {
        "valid": True,
        "reviewId": review["reviewId"],
        "predecessorReviewId": predecessor_result["reviewId"],
        "lockId": predecessor_result["lockId"],
        "componentCount": predecessor_result["componentCount"],
        "requiredHumanDecisionCount": 5,
        "approvedHumanDecisionCount": 5,
        "pendingHumanDecisionCount": 0,
        "allRequiredHumanDecisionsApproved": True,
        "automatedReleaseVerificationComplete": False,
        "releaseEligible": False,
        "task22_1Complete": False,
        "packetDigest": digest_bytes(path.read_bytes()),
    }


def validate(path: Path = REVIEW) -> dict[str, Any]:
    review = json.loads(path.read_text(encoding="utf-8"))
    require(
        review.get("schemaVersion") == 3
        and review.get("reviewId") == "teamaibox.airplay-compatible-supply-chain-review.v3",
        "open-source review identity drifted",
    )
    require(review.get("asOf") == "2026-09-06", "open-source review date drifted")

    predecessor = review.get("predecessor")
    require(isinstance(predecessor, Mapping), "open-source predecessor is missing")
    require(
        predecessor.get("path") == "architecture/validation/airplay-compatible-supply-chain-review.v2.json"
        and predecessor.get("reviewId") == "teamaibox.airplay-compatible-supply-chain-review.v2",
        "open-source predecessor identity drifted",
    )
    predecessor_path = (ROOT / str(predecessor["path"])).resolve()
    require(
        predecessor_path == REVIEW_V2.resolve()
        and predecessor.get("fileSha256") == digest_bytes(predecessor_path.read_bytes()),
        "open-source predecessor digest drifted",
    )
    predecessor_result = validate_v2(predecessor_path)

    scope = review.get("scopeDecision")
    require(isinstance(scope, Mapping), "open-source scope decision is missing")
    require(
        scope.get("path") == "docs/operations/airplay-compatible-open-source-release-minimum.v3.md"
        and SCOPE_DECISION.is_file()
        and scope.get("fileSha256") == digest_bytes(SCOPE_DECISION.read_bytes()),
        "open-source scope decision digest drifted",
    )
    require(scope.get("authorityType") == "requesting-project-authority"
            and scope.get("captureChannel") == "explicit-user-message-in-current-authenticated-codex-task"
            and scope.get("recordedAt") == "2026-09-06"
            and scope.get("statement") == "我觉得不用这么麻烦，因为这个产品是开源的。",
            "open-source scope authority record drifted")
    scope_text = SCOPE_DECISION.read_text(encoding="utf-8")
    for phrase in (
        "one basic SPDX JSON SBOM", "unaccepted Critical vulnerability",
        "normal Team AI Box image", "not development or open-source release gates",
        PRODUCT_COPY_EN, DRM_COPY_EN, "not legal advice",
    ):
        require(phrase in scope_text, f"open-source scope record omits boundary: {phrase}")

    require(review.get("humanDecisionInheritance") == {
        "required": 5,
        "approved": 5,
        "pending": 0,
        "inheritedWithoutModification": True,
    }, "approved human-decision inheritance drifted")
    require(set(review.get("mandatoryOpenSourceReleaseGates", [])) == MANDATORY_OPEN_SOURCE_GATES,
            "mandatory open-source gate set drifted")
    require(set(review.get("optionalAssuranceNotRequired", [])) == OPTIONAL_ASSURANCE,
            "optional assurance boundary drifted")
    require(review.get("decision") == {
        "status": "simplified-open-source-verification-authorized",
        "allRequiredHumanDecisionsApproved": True,
        "developmentBuildAuthorized": True,
        "automatedReleaseVerificationComplete": False,
        "releaseEligible": False,
        "task22_1Complete": False,
    }, "open-source scope decision overclaims technical completion")
    require(review.get("productBoundary") == {
        "productCopyEnglish": PRODUCT_COPY_EN,
        "productCopyChinese": PRODUCT_COPY_ZH,
        "appleLogoOrBadgeAllowed": False,
        "appleOrMfiCertificationClaimAllowed": False,
        "fairPlayDrmProtectedContentSupported": False,
    }, "open-source product-copy or DRM boundary drifted")
    require(review.get("deploymentBoundary") == {
        "sourceAndLocalBuildMayContinue": True,
        "remoteDeploymentBlockedUntilMandatoryGatesPass": True,
        "receiverAdvertisementBlockedUntilRealDeviceAcceptance": True,
    }, "open-source deployment boundary drifted")

    return {
        "valid": True,
        "reviewId": review["reviewId"],
        "predecessorReviewId": predecessor_result["reviewId"],
        "lockId": predecessor_result["lockId"],
        "componentCount": predecessor_result["componentCount"],
        "requiredHumanDecisionCount": 5,
        "approvedHumanDecisionCount": 5,
        "pendingHumanDecisionCount": 0,
        "allRequiredHumanDecisionsApproved": True,
        "mandatoryAutomatedGateCount": len(MANDATORY_OPEN_SOURCE_GATES),
        "optionalAssuranceCount": len(OPTIONAL_ASSURANCE),
        "automatedReleaseVerificationComplete": False,
        "releaseEligible": False,
        "task22_1Complete": False,
        "packetDigest": digest_bytes(path.read_bytes()),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--review", type=Path, default=REVIEW)
    arguments = parser.parse_args()
    print(json.dumps(validate(arguments.review), sort_keys=True, separators=(",", ":")))
