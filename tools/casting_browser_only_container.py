"""Browser-only media container configuration; no Docker/SSH operations.

The rollout must independently verify the ARM64 image, private tmpfs credential
directory, protected office workers and stopped legacy receiver before creation.
This module neither retires the HDMI helper nor authorizes a maintenance reboot.
"""
from copy import deepcopy
import re


RUN = re.compile(r"casting-browser-only-20[0-9]{6}-a[1-9][0-9]{0,3}")
IMAGE = re.compile(r"sha256:[0-9a-f]{64}")
CREDENTIAL_ROOT = "/run/teamaibox/casting/"
DESTINATION = "/run/teamaibox/credentials"


def need(value, code):
    if not value:
        raise ValueError(code)


def media_payload(*, run_id, image_id, credential_directory):
    """Explicit runc also blocks a host's default NVIDIA runtime injection."""
    need(isinstance(run_id, str) and RUN.fullmatch(run_id), "bounded_run_id_required")
    need(isinstance(image_id, str) and IMAGE.fullmatch(image_id), "exact_image_id_required")
    expected_directory = CREDENTIAL_ROOT + run_id + "/media"
    need(credential_directory == expected_directory, "exact_private_credentials_required")
    return {
        "Image": image_id,
        "User": "65532:65532",
        "WorkingDir": "/nonexistent",
        "Entrypoint": ["/usr/bin/python3", "-m", "services.trusted_media_runtime.appliance"],
        "Labels": {"org.teamaibox.run": run_id, "org.teamaibox.casting.role": "media"},
        "Env": ["PYTHONPATH=/opt/teamaibox", "PYTHONDONTWRITEBYTECODE=1", "GST_DEBUG=0",
                "GST_REGISTRY=/run/teamaibox/gst-registry.bin", "NVIDIA_VISIBLE_DEVICES=void",
                "NVIDIA_DRIVER_CAPABILITIES=",
                # gst-plugins-rs validates the private WSS publisher endpoint.
                # The CA is RAM-only in the same read-only credential mount.
                "SSL_CERT_FILE=/run/teamaibox/credentials/ca.crt"],
        "HostConfig": {
            "Runtime": "runc", "NetworkMode": "host", "ReadonlyRootfs": True,
            "Privileged": False, "Devices": [], "DeviceRequests": [],
            "CapDrop": ["ALL"], "CapAdd": [], "SecurityOpt": ["no-new-privileges"],
            "Memory": 3 * 2**30, "MemorySwap": 3 * 2**30, "NanoCpus": 4 * 10**9,
            "PidsLimit": 256, "LogConfig": {"Type": "none", "Config": {}},
            # Enable service restart only after successful authenticated readiness.
            "RestartPolicy": {"Name": "no"},
            "Mounts": [{"Type": "bind", "Source": credential_directory, "Target": DESTINATION,
                        "ReadOnly": True, "BindOptions": {"Propagation": "rprivate"}}],
            "Tmpfs": {
                "/run/teamaibox": "rw,nosuid,nodev,noexec,uid=65532,gid=65532,mode=0700,size=256m",
                "/run/avahi-daemon": "rw,nosuid,nodev,noexec,uid=65532,gid=65532,mode=0700,size=4m",
                "/tmp": "rw,nosuid,nodev,noexec,uid=65532,gid=65532,mode=0700,size=64m",
            },
        },
    }


def verify_media_container(inspected, *, run_id, image_id, credential_directory):
    """Read-only post-create guard before startup; fails on missing inspect data.

It deliberately does not emit the full configuration (which could contain
secrets), infer service health or stand in for actual Apple/browser acceptance.
"""
    expected = media_payload(run_id=run_id, image_id=image_id, credential_directory=credential_directory)
    try:
        config, host = inspected["Config"], inspected["HostConfig"]
        need(inspected["Image"] == image_id, "media_image_changed")
        for key in ("User", "WorkingDir", "Entrypoint"):
            need(config[key] == expected[key], "media_process_policy_changed")
        need(all(config["Labels"].get(k) == v for k, v in expected["Labels"].items()), "media_owner_changed")
        actual_env = config["Env"]
        for entry in expected["Env"]:
            key = entry.split("=", 1)[0] + "="
            need([v for v in actual_env if v.startswith(key)] == [entry], "media_environment_changed")
        for key in ("Runtime", "NetworkMode", "ReadonlyRootfs", "Privileged", "Memory", "MemorySwap",
                    "NanoCpus", "PidsLimit", "Tmpfs"):
            need(host[key] == expected["HostConfig"][key], "media_sandbox_changed")
        for key in ("Devices", "DeviceRequests", "CapAdd"):
            need(host[key] in (None, []), "media_device_or_capability_added")
        need(host["CapDrop"] == ["ALL"] and host["SecurityOpt"] in
             (["no-new-privileges"], ["no-new-privileges:true"]), "media_privilege_changed")
        need(host["LogConfig"]["Type"] == "none", "media_logging_enabled")
        need(not host.get("Binds") and not host.get("VolumesFrom") and not host.get("DeviceCgroupRules"),
             "media_unreviewed_host_access")
        need(host.get("PidMode", "") == "" and host.get("IpcMode", "private") == "private",
             "media_host_namespace_added")
        mounts = inspected["Mounts"]
        binds = [m for m in mounts if m["Type"] != "tmpfs"]
        need(len(binds) == 1 and binds[0]["Type"] == "bind" and binds[0]["Source"] == credential_directory
             and binds[0]["Destination"] == DESTINATION and binds[0]["RW"] is False
             and binds[0]["Propagation"] == "rprivate", "media_mount_changed")
        need(all(m["Destination"] in expected["HostConfig"]["Tmpfs"] for m in mounts if m["Type"] == "tmpfs"),
             "media_tmpfs_changed")
    except (KeyError, TypeError, AttributeError):
        raise ValueError("media_inspect_incomplete") from None
    return {"imageId": image_id, "runId": run_id, "browserOnlyContainerPolicy": True,
            "readinessPassed": False, "appleSenderAccepted": False, "productAccepted": False}


def successor_configuration(runtime_config, identity_config):
    """Return new in-memory copies; never modify old private inputs or evidence."""
    need(type(runtime_config) is dict and runtime_config.get("schemaVersion") in (1, 2), "runtime_config_invalid")
    need(type(identity_config) is dict and identity_config.get("schemaVersion") == 1
         and set(identity_config) == {"schemaVersion", "nodeId", "nodeGeneration"},
         "runtime_identity_invalid")
    runtime, identity = deepcopy(runtime_config), deepcopy(identity_config)
    runtime.pop("hdmi", None)
    return runtime, identity
