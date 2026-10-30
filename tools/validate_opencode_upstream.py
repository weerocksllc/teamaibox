#!/usr/bin/env python3
"""Validate the pinned, non-invasive OpenCode serve boundary."""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
LOCK = ROOT / "architecture/opencode/upstream-lock.v1.json"
SHA1 = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")


def require(value: bool, message: str) -> None:
    if not value:
        raise ValueError(message)


def load_and_validate() -> dict:
    lock = json.loads(LOCK.read_text())
    require(lock.get("schemaVersion") == 1, "OpenCode lock schema is invalid")
    require(lock.get("adapterKey") == "opencode.http.v1.18", "OpenCode adapter key is not pinned")
    upstream = lock.get("upstream", {})
    source = upstream.get("providedSource", {})
    release = upstream.get("release", {})
    require(upstream.get("repository") == "https://github.com/anomalyco/opencode.git", "OpenCode repository is invalid")
    require(upstream.get("license") == "MIT", "OpenCode license inventory is invalid")
    require(source.get("packageVersion") == release.get("tag", "").removeprefix("v"), "source and release versions differ")
    require(source.get("modifiedByPlatform") is False, "platform must not modify upstream OpenCode")
    require(bool(SHA1.fullmatch(source.get("commit", ""))), "provided source commit is invalid")
    require(bool(SHA1.fullmatch(source.get("tree", ""))), "provided source tree is invalid")
    require(bool(SHA1.fullmatch(release.get("commit", ""))), "release commit is invalid")
    require(source.get("tree") == release.get("tree"), "provided source does not match pinned release tree")
    require(release.get("sourceTreeMatchesProvidedSource") is True, "source/release match was not attested")
    artifact = lock.get("runtimeArtifact", {})
    require(artifact.get("platform") == "linux/arm64/v8", "OpenCode runtime is not Spark ARM64")
    require(artifact.get("name") == "opencode-linux-arm64.tar.gz", "OpenCode artifact name is invalid")
    require(isinstance(artifact.get("sizeBytes"), int) and artifact["sizeBytes"] > 50_000_000, "OpenCode artifact size is invalid")
    require(bool(SHA256.fullmatch(artifact.get("digest", ""))), "OpenCode artifact digest is not pinned")
    serve = lock.get("serveBoundary", {})
    require(serve.get("command") == ["/opt/opencode/opencode", "serve", "--hostname", "127.0.0.1", "--port", "4096"], "OpenCode serve command drifted")
    require(serve.get("transport") == "sandbox-loopback-http", "OpenCode must be loopback-only inside the sandbox")
    require(serve.get("networkClient") == "platform-agent-bridge-only", "OpenCode network client boundary is invalid")
    operations = lock.get("requiredOperations", [])
    keys = [operation.get("key") for operation in operations]
    require(len(keys) == len(set(keys)) and len(keys) == 14, "OpenCode operation inventory is incomplete or duplicated")
    require({"health", "session.create", "session.prompt", "session.interrupt", "session.diff", "event.subscribe", "question.reply", "permission.reply"}.issubset(keys), "OpenCode bridge operations are incomplete")
    require(all(operation.get("method") in {"GET", "POST"} and str(operation.get("path", "")).startswith("/") for operation in operations), "OpenCode operation declaration is invalid")
    blocked = {operation.get("key") for operation in lock.get("blockedOperations", [])}
    require(blocked == {"global.upgrade", "session.share", "config.update", "provider.authorize"}, "OpenCode blocked surface drifted")
    policy = lock.get("runtimePolicy", {})
    require(policy.get("requiredEnvironment") == {
        "XDG_CONFIG_HOME": "/run/teamaibox/xdg-config",
        "OPENCODE_CONFIG": "/run/teamaibox/xdg-config/opencode/opencode.json",
        "OPENCODE_DISABLE_PROJECT_CONFIG": "1",
        "OPENCODE_DISABLE_AUTOUPDATE": "1",
        "OPENCODE_DISABLE_SHARE": "1",
        "OPENCODE_AUTO_SHARE": "false",
        "OPENCODE_PURE": "1",
        "OPENCODE_DISABLE_DEFAULT_PLUGINS": "1",
        "OPENCODE_DISABLE_EXTERNAL_SKILLS": "1",
        "OPENCODE_DISABLE_MODELS_FETCH": "1",
        "OPENCODE_DISABLE_EMBEDDED_WEB_UI": "1",
        "OPENCODE_PERMISSION": '{"*":"ask"}',
    }, "OpenCode hardening environment drifted")
    require(policy.get("configurationTarget") == "/run/teamaibox/xdg-config/opencode/opencode.json" and
            policy.get("configurationOwner") == "root:root" and policy.get("configurationMode") == "0444",
            "OpenCode immutable configuration projection drifted")
    require(policy.get("approvedProviders") == ["teamaibox"] and policy.get("approvedPlugins") == [],
            "OpenCode provider or plugin restriction drifted")
    require(policy.get("passwordMustBeInjectedAsSecret") is True and policy.get("passwordMustNotBePersisted") is True, "OpenCode password policy is invalid")
    require(policy.get("upstreamEventReplayIsNotAssumed") is True and policy.get("platformPersistsOrderedEventsBeforeDelivery") is True, "OpenCode replay ownership is invalid")
    return lock


def verify_provided_source(lock: dict) -> None:
    source = lock["upstream"]["providedSource"]
    directory = (ROOT / source["relativeWorkspace"]).resolve()
    require((directory / ".git").exists(), "provided OpenCode source is not present")
    def git(*arguments: str) -> str:
        return subprocess.run(["git", "-C", str(directory), *arguments], check=True, capture_output=True, text=True).stdout.strip()
    require(not git("status", "--porcelain"), "provided OpenCode source has local modifications")
    require(git("rev-parse", "HEAD") == source["commit"], "provided OpenCode commit drifted")
    require(git("rev-parse", "HEAD^{tree}") == source["tree"], "provided OpenCode tree drifted")
    require(git("rev-parse", f"{lock['upstream']['release']['tag']}^{{tree}}") == source["tree"], "local release tag tree differs")
    package = json.loads((directory / "packages/opencode/package.json").read_text())
    require(package.get("name") == source["package"] and package.get("version") == source["packageVersion"], "provided OpenCode package identity drifted")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify-provided-source", action="store_true")
    args = parser.parse_args()
    lock = load_and_validate()
    if args.verify_provided_source:
        verify_provided_source(lock)
    print(f"OpenCode upstream valid: {lock['upstream']['release']['tag']} {lock['runtimeArtifact']['platform']} {lock['runtimeArtifact']['digest']}")


if __name__ == "__main__":
    main()
