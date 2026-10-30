#!/usr/bin/env python3
"""Remote, bounded Platform-only cutover. Keeps credentials in process memory."""
import os
import argparse
import copy
import http.client
import json
import re
import socket
import subprocess
import time
from urllib.parse import quote

PLATFORM = os.environ.get('TEAMAIBOX_ROLLOUT_CASTING_UI_PLATFORM_PLATFORM')
PARENT_ID = os.environ.get('TEAMAIBOX_ROLLOUT_CASTING_UI_PLATFORM_PARENT_ID')
PARENT_IMAGE = os.environ.get('TEAMAIBOX_ROLLOUT_CASTING_UI_PLATFORM_PARENT_IMAGE')


class Docker(http.client.HTTPConnection):
    def __init__(self):
        super().__init__("localhost", timeout=40)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(40)
        self.sock.connect("/var/run/docker.sock")


def api(method, path, body=None, expected=(200, 201, 204)):
    connection = Docker()
    try:
        connection.request(method, "/v1.47" + path, None if body is None else json.dumps(body),
                           {"Content-Type": "application/json"})
        response = connection.getresponse()
        payload = response.read()
        if response.status not in expected:
            raise RuntimeError("docker_operation_failed:" + method + ":" + str(response.status))
        return json.loads(payload) if payload else None
    finally:
        connection.close()


def inspect(name):
    return api("GET", "/containers/" + quote(name, safe="") + "/json")


def facts(container):
    return {"name": container["Name"][1:], "containerId": container["Id"], "imageId": container["Image"],
            "startedAt": container["State"]["StartedAt"],
            "healthy": container["State"].get("Health", {}).get("Status") == "healthy"}


def workers():
    # Only the six protected office containers, never historical stopped workers.
    identities = (
        "45dece00-515c-5658-b903-e7b68689cebb", "50ed0d01-9b60-5ec3-a840-d8f56127c53e",
        "c2e3e722-08da-5141-89f5-b8244deb817f", "b3ea0138-4acf-5840-ad1d-5b698cc89cf5",
        "7f97d6a6-d63c-5383-8cf8-a93841437494", "4ac86c89-ef71-5fe5-8a6a-0e8979fff66d",
    )
    result = [facts(inspect("teamaibox-worker-" + worker)) for worker in identities]
    return sorted(result, key=lambda item: item["name"])


def wait_healthy(cid):
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        item = inspect(cid)
        if item["State"].get("Health", {}).get("Status") == "healthy":
            return item
        if item["State"]["Status"] in {"exited", "dead"}:
            break
        time.sleep(1)
    raise RuntimeError("candidate_readiness_failed")


def clone_payload(parent, image, run_id):
    if PARENT_ID is None:
        raise ValueError('explicit_TEAMAIBOX_ROLLOUT_CASTING_UI_PLATFORM_PARENT_ID_required')
    if PARENT_IMAGE is None:
        raise ValueError('explicit_TEAMAIBOX_ROLLOUT_CASTING_UI_PLATFORM_PARENT_IMAGE_required')
    if parent["Id"] != PARENT_ID or parent["Image"] != PARENT_IMAGE:
        raise RuntimeError("exact_platform_parent_changed")
    host = copy.deepcopy(parent["HostConfig"])
    if host["Privileged"] or not host["ReadonlyRootfs"] or host.get("Devices") or host.get("DeviceRequests"):
        raise RuntimeError("parent_is_not_device_free")
    config = copy.deepcopy(parent["Config"])
    config["Image"] = image
    config["Hostname"] = ""
    config["Labels"] = {**(config.get("Labels") or {}), "com.teamaibox.run-id": run_id}
    config["Env"] = [item for item in config["Env"] if not item.startswith("PLATFORM_CASTING_AVAILABILITY_FILE=")]
    config["Env"].append("PLATFORM_CASTING_AVAILABILITY_FILE=/opt/teamaibox/config/wireless-casting-control-plane.disabled.v2.json")
    host["RestartPolicy"] = {"Name": "no", "MaximumRetryCount": 0}
    config["HostConfig"] = host
    config["NetworkingConfig"] = {"EndpointsConfig": {name: {"Aliases": [run_id]}
        for name in parent["NetworkSettings"]["Networks"]}}
    return config


def main():
    if PARENT_ID is None:
        raise ValueError('explicit_TEAMAIBOX_ROLLOUT_CASTING_UI_PLATFORM_PARENT_ID_required')
    if PARENT_IMAGE is None:
        raise ValueError('explicit_TEAMAIBOX_ROLLOUT_CASTING_UI_PLATFORM_PARENT_IMAGE_required')
    if PLATFORM is None:
        raise ValueError('explicit_TEAMAIBOX_ROLLOUT_CASTING_UI_PLATFORM_PLATFORM_required')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"wireless-casting-ui-deployment-20\d{6}-a[1-9]\d*", args.run_id):
        raise RuntimeError("invalid_run_identity")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", args.image) or args.image == PARENT_IMAGE:
        raise RuntimeError("invalid_candidate_image")
    candidate_name = "teamaibox-" + args.run_id
    rollback_name = candidate_name + "-rollback"
    parent = inspect(PLATFORM)
    before = workers()
    if len(before) != 6 or not all(item["healthy"] for item in before):
        raise RuntimeError("protected_office_set_not_healthy")
    payload = clone_payload(parent, args.image, args.run_id)
    created = api("POST", "/containers/create?name=" + candidate_name, payload)["Id"]
    switched = False
    report = {"runId": args.run_id, "status": "failed", "scope": "platform-config-and-disabled-casting-ui-only",
              "parent": facts(parent), "protectedWorkersBefore": before, "receiverDeployed": False,
              "browserAccepted": False, "productAccepted": False}
    try:
        api("POST", "/containers/" + created + "/start")
        wait_healthy(created)
        # Load the exact disabled successor in the real image before any cutover.
        probe = subprocess.run(["docker", "exec", created, "node", "--input-type=module", "-e",
            "import {FileDisabledCastingAvailability as A} from '/opt/teamaibox/apps/platform-api/src/casting/file-disabled-casting-availability.mjs';"
            "const a=await A.fromFile(process.env.PLATFORM_CASTING_AVAILABILITY_FILE);"
            "const s=a.status();if(s.receiverReady||s.sessionStartAllowed||s.receiverAdvertisementAllowed||s.gates.length!==3)process.exit(2)"],
            capture_output=True, timeout=20)
        if probe.returncode:
            raise RuntimeError("disabled_status_probe_failed")
        if workers() != before:
            raise RuntimeError("protected_worker_changed_before_cutover")
        api("POST", "/containers/" + PARENT_ID + "/stop?t=20")
        api("POST", "/containers/" + PARENT_ID + "/rename?name=" + rollback_name)
        switched = True
        api("POST", "/containers/" + created + "/rename?name=" + PLATFORM)
        for network, endpoint in parent["NetworkSettings"]["Networks"].items():
            api("POST", "/networks/" + quote(network, safe="") + "/disconnect", {"Container": created})
            api("POST", "/networks/" + quote(network, safe="") + "/connect", {
                "Container": created, "EndpointConfig": {"Aliases": endpoint.get("Aliases") or []}})
        api("POST", "/containers/" + created + "/update", {"RestartPolicy": {"Name": "unless-stopped"}})
        api("POST", "/containers/" + PARENT_ID + "/update", {"RestartPolicy": {"Name": "no"}})
        current = wait_healthy(created)
        if workers() != before:
            raise RuntimeError("protected_worker_changed_after_cutover")
        report.update(status="passed", current=facts(current), rollback=rollback_name,
                      protectedWorkersUnchanged=True, disabledStatusVerified=True)
    except Exception as error:
        # Candidate ID came from our create call; never remove another container.
        api("DELETE", "/containers/" + created + "?force=1", expected=(204, 404))
        if switched:
            api("POST", "/containers/" + PARENT_ID + "/rename?name=" + PLATFORM)
        api("POST", "/containers/" + PARENT_ID + "/update", {"RestartPolicy": parent["HostConfig"]["RestartPolicy"]})
        api("POST", "/containers/" + PARENT_ID + "/start", expected=(204, 304))
        wait_healthy(PARENT_ID)
        report.update(failure=str(error), rollbackRestored=True, protectedWorkersUnchanged=workers() == before)
    print(json.dumps(report))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
