"""Read-only evaluation of unavoidable trusted-media host exceptions."""

from __future__ import annotations

from typing import Mapping


def evaluate_host_exceptions(
    policy: Mapping[str, object],
    hardware_evidence: Mapping[str, object],
    *,
    observed_services: Mapping[str, str] | None = None,
    unregistered_host_changes: tuple[str, ...] = (),
) -> dict[str, object]:
    """Compare derived hardware facts without executing or mutating the host."""

    drifts: list[dict[str, str]] = []
    observed_services = dict(observed_services or {})
    inventory = hardware_evidence.get("inventory", {})
    source = policy.get("sourceHardwareEvidence", {})
    if hardware_evidence.get("evidenceDigest") != source.get("evidenceDigest"):
        drifts.append({"key": "hardware.evidenceDigest", "reason": "exact hardware parent changed"})
    if hardware_evidence.get("target") != policy.get("target"):
        drifts.append({"key": "hardware.target", "reason": "target identity changed"})
    if inventory.get("architecture") != policy.get("architecture"):
        drifts.append({"key": "hardware.architecture", "reason": "architecture changed"})

    observed_device_paths = set(inventory.get("devices", {}))
    audio_names = set(inventory.get("audio", {}).get("deviceNodeNames", []))
    for exception in policy.get("exceptions", []):
        for path in exception.get("scope", []) if isinstance(exception.get("scope"), list) else []:
            if path.startswith("/dev/snd/"):
                present = path.rsplit("/", 1)[-1] in audio_names
            else:
                present = path in observed_device_paths and inventory["devices"][path].get("present") is True
            if not present:
                drifts.append({"key": f"device:{path}", "reason": "required exact device is absent or unobserved"})

    derived_services = {
        "avahi-daemon.service": "active" if inventory.get("discovery", {}).get("avahiActive") is True else "inactive",
        "display-manager.service": "active" if inventory.get("display", {}).get("managerActive") is True else "inactive",
    }
    derived_services.update(observed_services)
    for service in policy.get("allowedHostFoundation", {}).get("services", []):
        name, required = service.get("name"), service.get("requiredState")
        actual = derived_services.get(name)
        if actual is None:
            drifts.append({"key": f"service:{name}", "reason": "service state was not observed by this evidence"})
        elif actual != required:
            drifts.append({"key": f"service:{name}", "reason": "service state changed"})

    for key in sorted(set(unregistered_host_changes)):
        drifts.append({"key": f"unregistered:{key}", "reason": "host change is outside the deny-by-default exception set"})

    hardware_supported = inventory.get("decision", {}).get("supportedEnvironment") is True
    return {
        "conforming": not drifts,
        "hardwareSupported": hardware_supported,
        "releaseEvidenceEligible": not drifts and hardware_supported,
        "mutationPerformed": False,
        "drifts": drifts,
    }
