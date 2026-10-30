"""User-approved temporary greeter handoff with host-side restore watchdog.

No boot configuration, network, storage or model mutation. Refuses any local
non-greeter seat session. The HDMI child has its own exact immutable evidence.
"""
import argparse
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys

from run_trusted_media_hdmi_component import ROOT, canonical, digest, ssh, snapshot, utc


def checked(command, timeout=25):
    result = ssh(command, timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError("bounded host operation failed")
    return result.stdout.decode().strip()


def seats():
    # Query physical seats only: the SSH connection used for a global session
    # listing is already gone by the next SSH call and must not be inspected.
    seat_rows = checked("loginctl list-seats --no-legend --no-pager").splitlines()
    ids = []
    for line in seat_rows:
        seat = line.split()[0]
        if not re.fullmatch(r"seat[A-Za-z0-9_-]+", seat): raise ValueError("invalid seat ID")
        ids.extend(checked("loginctl show-seat " + seat + " -p Sessions --value").split())
    result = []
    for session in ids:
        if not re.fullmatch(r"[A-Za-z0-9]+", session): raise ValueError("invalid session ID")
        props = dict(row.split("=", 1) for row in checked("loginctl show-session " + session +
            " -p Class -p Type -p Remote -p Seat -p State").splitlines())
        if props.get("Seat"):
            if props.get("Class") != "greeter" or props.get("Remote") != "no":
                raise ValueError("local desktop session in use; refusing handoff")
            result.append(props)
    if len(result) != 1: raise ValueError("one greeter required")
    return result


def run(run_id, child_run, seconds=10, session_api=False):
    if type(seconds) is not int or not 5 <= seconds <= 60:
        raise ValueError("test duration must be 5 through 60 seconds")
    if type(session_api) is not bool or (session_api and seconds < 10):
        raise ValueError("session test requires at least 10 seconds")
    if (not re.fullmatch(r"hdmi-greeter-handoff-20[0-9]{6}-a[1-9][0-9]*", run_id)
            or not re.fullmatch(r"casting-hdmi-component-20[0-9]{6}-a[1-9][0-9]*", child_run)):
        raise ValueError("bounded IDs required")
    path = ROOT / "evidence/validation/host-maintenance" / (run_id + ".json")
    child_path = ROOT / "evidence/validation/components" / (child_run + ".json")
    claim = ROOT / "tmp" / (run_id + ".claim")
    timer = "teamaibox-" + run_id + "-restore"
    if path.exists() or claim.exists() or child_path.exists() or (ROOT / "tmp" / (child_run + ".claim")).exists():
        raise ValueError("identity already used")
    original = checked("systemctl show display-manager -p Id --value")
    if original != "gdm.service" or checked("systemctl is-active display-manager") != "active":
        raise ValueError("expected active GDM missing")
    greeters = seats()
    if checked("systemctl show " + shlex.quote(timer + ".timer") + " -p LoadState --value") != "not-found":
        raise ValueError("restore timer identity occupied")
    before = snapshot()
    with claim.open("x") as output: output.write(run_id)
    report = {"schemaVersion": 1, "runId": run_id, "startedAt": utc(), "status": "failed",
        "userAuthorizedTemporaryGreeterStop": True, "greeterBefore": greeters, "beforeContainers": before,
        "sourceDigest": digest(Path(__file__).read_bytes()), "watchdogArmed": False,
        "displayReleased": False, "displayRestored": False, "watchdogRemoved": False,
        "bootConfigChanged": False, "networkChanged": False, "modelsStopped": False,
        "childRunId": child_run, "productAccepted": False, "requestedPlaybackSeconds": seconds,
        "restoreWatchdogSeconds": seconds + 90}
    touched = False
    try:
        checked("sudo -n systemd-run --quiet --unit=" + shlex.quote(timer) +
                " --on-active=" + str(seconds + 90) + "s --timer-property=AccuracySec=1s /usr/bin/systemctl start display-manager.service")
        report["watchdogArmed"] = checked("systemctl is-active " + shlex.quote(timer + ".timer")) == "active"
        if not report["watchdogArmed"]: raise ValueError("restore watchdog not armed")
        seats()  # Recheck immediately before stopping the greeter.
        touched = True
        checked("sudo -n systemctl stop display-manager.service")
        report["displayReleased"] = ssh("systemctl is-active display-manager").stdout.decode().strip() == "inactive"
        if not report["displayReleased"]: raise ValueError("display not released")
        child = subprocess.run([sys.executable, str(ROOT / "tools/run_trusted_media_hdmi_component.py"),
            "--run-id", child_run, "--seconds", str(seconds)] + (["--session-api"] if session_api else []), cwd=ROOT, stderr=subprocess.PIPE,
            text=True, timeout=seconds + 65)
        report["childExitCode"] = child.returncode
        if child_path.exists():
            evidence = json.loads(child_path.read_bytes())
            report["childEvidenceDigest"] = evidence["evidenceDigest"]
            report["childStatus"] = evidence["status"]
        if child.returncode == 0 and report.get("childStatus") == "passed":
            report["status"] = "passed"
    except Exception as error:
        report["errorClass"] = type(error).__name__
    finally:
        try:
            if touched:
                checked("sudo -n systemctl start display-manager.service")
            report["displayRestored"] = checked("systemctl is-active display-manager") == "active"
            if report["displayRestored"]:
                checked("sudo -n systemctl stop " + shlex.quote(timer + ".timer"))
                state = ssh("systemctl is-active " + shlex.quote(timer + ".timer")).stdout.decode().strip()
                report["watchdogRemoved"] = state in ("inactive", "unknown")
            report["afterContainers"] = snapshot()
            report["unrelatedContainersUnchanged"] = report["afterContainers"] == before
        except Exception as error:
            report["recoveryErrorClass"] = type(error).__name__
            # Leave the host-side timer armed if restoration is unconfirmed.
        if not all(report.get(key) is True for key in ("displayRestored", "watchdogRemoved", "unrelatedContainersUnchanged")):
            report["status"] = "failed"
        report["completedAt"] = utc()
        report["evidenceDigest"] = digest(canonical(report))
        with path.open("x") as output: json.dump(report, output, sort_keys=True, indent=2)
        print(json.dumps({key: report.get(key) for key in ("runId", "status", "childStatus", "displayRestored",
            "watchdogRemoved", "unrelatedContainersUnchanged", "evidenceDigest")}))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--child-run-id", required=True)
    parser.add_argument("--seconds", type=int, choices=range(5, 61), default=10)
    parser.add_argument("--session-api", action="store_true")
    args = parser.parse_args()
    raise SystemExit(run(args.run_id, args.child_run_id, args.seconds, args.session_api))
