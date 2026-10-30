#!/usr/bin/env python3
"""Exercise content-safe OpenAI HTTP faults against one live model worker.

The probe keeps generated content in memory only. Evidence contains response
digests, status codes, token counts, and assertions; it never contains prompts
or model output.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import pathlib
import re
import socket
import threading
import time
import urllib.error
import urllib.request
from typing import Any


SCHEMA_VERSION = 1
PROBE_VERSION = "1.0.0"
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
SAFE_ENDPOINT = re.compile(r"^http://teamaibox-model-[a-z0-9-]{3,80}:8000$")
SAFE_MODEL = re.compile(r"^[a-z0-9][a-z0-9._-]{2,100}$")
SAFE_RUN_ID = re.compile(r"^[a-z0-9][a-z0-9-]{7,79}$")
SHA256 = re.compile(r"^sha256:[a-f0-9]{64}$")
INTEGRITY_MARKER = "TEAMAIBOX_INTEGRITY_V1"


class FaultProbeError(RuntimeError):
    pass


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def digest_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def canonical_digest(value: Any) -> str:
    return digest_bytes(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


class HostMemorySampler:
    def __init__(self, proc_root: pathlib.Path, interval_seconds: float = 0.2):
        self.proc_root = proc_root
        self.interval_seconds = interval_seconds
        self.samples: list[int] = []
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None

    def sample(self) -> int:
        try:
            lines = (self.proc_root / "meminfo").read_text(encoding="utf-8").splitlines()
            value = next(int(line.split()[1]) * 1024 for line in lines if line.startswith("MemAvailable:"))
        except (OSError, UnicodeError, StopIteration, ValueError, IndexError) as error:
            raise FaultProbeError("host unified-memory evidence is unavailable") from error
        if value < 1:
            raise FaultProbeError("host unified-memory evidence is invalid")
        return value

    def __enter__(self) -> "HostMemorySampler":
        self.samples = [self.sample()]
        self.stop_event.clear()
        def collect() -> None:
            while not self.stop_event.wait(self.interval_seconds):
                try:
                    self.samples.append(self.sample())
                except FaultProbeError:
                    pass
        self.thread = threading.Thread(target=collect, name="fault-memory-sampler", daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=2)
        self.samples.append(self.sample())

    def summary(self) -> dict[str, Any]:
        if len(self.samples) < 2:
            raise FaultProbeError("host unified-memory sample is incomplete")
        return {"sampleCount": len(self.samples), "minimumHostAvailableMemoryBytes": min(self.samples)}


def bounded_read(response: Any) -> bytes:
    body = response.read(MAX_RESPONSE_BYTES + 1)
    if len(body) > MAX_RESPONSE_BYTES:
        raise FaultProbeError("response exceeded the evidence boundary")
    return body


def request_raw(url: str, body: bytes, *, timeout: float = 300) -> tuple[int, bytes]:
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, bounded_read(response)
    except urllib.error.HTTPError as error:
        return error.code, bounded_read(error)


def chat_payload(model: str, messages: list[dict[str, str]], max_tokens: int, *, stream: bool = False) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0,
        "seed": 1337,
        "stream": stream,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    if stream:
        payload["stream_options"] = {"include_usage": True}
    return payload


def post_chat(base_url: str, payload: dict[str, Any], *, timeout: float = 300) -> tuple[dict[str, Any], bytes, float]:
    started = time.monotonic()
    status, raw = request_raw(
        base_url + "/v1/chat/completions",
        json.dumps(payload, separators=(",", ":")).encode(),
        timeout=timeout,
    )
    elapsed_ms = round((time.monotonic() - started) * 1000, 3)
    if status != 200:
        raise FaultProbeError(f"chat request failed with status {status}")
    try:
        document = json.loads(raw)
    except json.JSONDecodeError as error:
        raise FaultProbeError("chat response was not JSON") from error
    return document, raw, elapsed_ms


def response_content(document: dict[str, Any]) -> str:
    try:
        content = document["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as error:
        raise FaultProbeError("chat response did not contain assistant content") from error
    if not isinstance(content, str):
        raise FaultProbeError("assistant content was not text")
    return content.strip()


def integrity(base_url: str, model: str) -> dict[str, Any]:
    document, raw, elapsed_ms = post_chat(
        base_url,
        chat_payload(model, [
            {"role": "system", "content": "Follow the user's output format exactly."},
            {"role": "user", "content": "Return only this exact ASCII string: " + INTEGRITY_MARKER},
        ], 32),
    )
    content = response_content(document)
    if content != INTEGRITY_MARKER:
        raise FaultProbeError("integrity sentinel was not reproduced exactly")
    usage = document.get("usage") if isinstance(document.get("usage"), dict) else {}
    return {
        "passed": True,
        "contentDigest": digest_bytes(content.encode()),
        "responseDigest": digest_bytes(raw),
        "completionTokens": usage.get("completion_tokens"),
        "latencyMs": elapsed_ms,
    }


def health(base_url: str) -> bool:
    try:
        with urllib.request.urlopen(base_url + "/health", timeout=10) as response:
            return response.status == 200
    except (urllib.error.URLError, TimeoutError, socket.timeout):
        return False


def metrics(base_url: str) -> tuple[int, int]:
    with urllib.request.urlopen(base_url + "/metrics", timeout=10) as response:
        raw = bounded_read(response).decode("utf-8", "replace")
    def value(name: str) -> int:
        matches = re.findall(rf"^{re.escape(name)}(?:\{{[^\n]*\}})?\s+([0-9.eE+-]+)$", raw, re.MULTILINE)
        if not matches:
            raise FaultProbeError(f"required aggregate metric is unavailable: {name}")
        return int(sum(float(item) for item in matches))
    return value("vllm:num_requests_running"), value("vllm:num_requests_waiting")


def wait_drained(base_url: str, timeout_seconds: int = 180) -> dict[str, Any]:
    started = time.monotonic()
    samples = 0
    while time.monotonic() - started < timeout_seconds:
        running, waiting = metrics(base_url)
        samples += 1
        if running == 0 and waiting == 0:
            return {"passed": True, "samples": samples, "drainTimeMs": round((time.monotonic() - started) * 1000, 3)}
        time.sleep(1)
    raise FaultProbeError("worker did not drain cancelled or timed-out requests")


def malformed_inputs(base_url: str, model: str) -> dict[str, Any]:
    cases = [
        b'{"model":',
        json.dumps({"model": model, "messages": "not-an-array"}, separators=(",", ":")).encode(),
    ]
    observations = []
    for body in cases:
        status, raw = request_raw(base_url + "/v1/chat/completions", body, timeout=30)
        try:
            document = json.loads(raw)
        except json.JSONDecodeError as error:
            raise FaultProbeError("malformed input did not receive a JSON error") from error
        if status not in (400, 422) or not isinstance(document, dict) or "error" not in document:
            raise FaultProbeError("malformed input was not rejected with an OpenAI-shaped client error")
        observations.append({"status": status, "errorShape": True, "responseDigest": digest_bytes(raw)})
    if not health(base_url):
        raise FaultProbeError("worker health failed after malformed inputs")
    return {"passed": True, "cases": observations, "workerHealthy": True}


def timeout_request(base_url: str, model: str) -> dict[str, Any]:
    payload = chat_payload(
        model,
        [{"role": "user", "content": "Write a long numbered list with a short explanation for every item."}],
        4096,
        stream=True,
    )
    request = urllib.request.Request(
        base_url + "/v1/chat/completions",
        data=json.dumps(payload, separators=(",", ":")).encode(),
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
    )
    started = time.monotonic()
    classification = "unexpected_response"
    try:
        with urllib.request.urlopen(request, timeout=0.01) as response:
            response.read(1)
    except (TimeoutError, socket.timeout):
        classification = "client_timeout"
    except urllib.error.URLError as error:
        if isinstance(error.reason, (TimeoutError, socket.timeout)):
            classification = "client_timeout"
        else:
            raise FaultProbeError("timeout request failed for a non-timeout reason") from error
    if classification != "client_timeout":
        raise FaultProbeError("bounded timeout request completed unexpectedly")
    drained = wait_drained(base_url)
    return {
        "passed": health(base_url), "classification": classification,
        "clientDeadlineMs": 10, "observedMs": round((time.monotonic() - started) * 1000, 3),
        "drain": drained,
    }


def cancel_stream(base_url: str, model: str) -> dict[str, Any]:
    payload = chat_payload(
        model,
        [{"role": "user", "content": "Generate a very long sequence of distinct short facts."}],
        4096,
        stream=True,
    )
    request = urllib.request.Request(
        base_url + "/v1/chat/completions",
        data=json.dumps(payload, separators=(",", ":")).encode(),
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
    )
    observed_event = False
    with urllib.request.urlopen(request, timeout=300) as response:
        for line in response:
            if line.startswith(b"data:") and line.strip() != b"data: [DONE]":
                observed_event = True
                break
    if not observed_event:
        raise FaultProbeError("stream cancellation did not observe a response event")
    drained = wait_drained(base_url)
    return {"passed": health(base_url), "streamEventObserved": True, "clientClosed": True, "drain": drained}


def cache_pressure(base_url: str, model: str) -> dict[str, Any]:
    repeated = "Edge AI keeps private workloads close to the team and schedules scarce compute carefully. " * 1_200
    # Differ the first cache block so the two simultaneous contexts cannot be
    # collapsed into one prefix-cache allocation.
    prompts = ["Independent request A. " + repeated, "Independent request B. " + repeated]
    def execute(index: int) -> dict[str, Any]:
        document, raw, latency = post_chat(
            base_url,
            chat_payload(model, [{"role": "user", "content": prompts[index] + "\nReply with OK."}], 32),
            timeout=900,
        )
        usage = document.get("usage") if isinstance(document.get("usage"), dict) else {}
        return {
            "responseDigest": digest_bytes(raw), "latencyMs": latency,
            "promptTokens": usage.get("prompt_tokens"), "completionTokens": usage.get("completion_tokens"),
        }
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(execute, range(2)))
    prompt_tokens = [item.get("promptTokens") for item in results]
    if any(not isinstance(item, int) or item < 16_000 or item > 32_768 for item in prompt_tokens):
        raise FaultProbeError("cache pressure did not reach the bounded long-context range")
    drained = wait_drained(base_url)
    return {
        "passed": health(base_url), "concurrency": 2, "completedRequests": len(results),
        "minimumPromptTokens": min(prompt_tokens), "maximumPromptTokens": max(prompt_tokens),
        "results": results, "drain": drained,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--profile-fingerprint", required=True)
    parser.add_argument("--deployment-fingerprint", required=True)
    parser.add_argument("--proc-root", type=pathlib.Path, default=pathlib.Path("/host-proc"))
    parser.add_argument("--integrity-only", action="store_true")
    parser.add_argument("--expected-integrity-digest")
    args = parser.parse_args()
    if not SAFE_ENDPOINT.fullmatch(args.base_url) or not SAFE_MODEL.fullmatch(args.model) or not SAFE_RUN_ID.fullmatch(args.run_id):
        raise FaultProbeError("probe endpoint, model, or run identity is outside the internal allowlist")
    if not SHA256.fullmatch(args.profile_fingerprint) or not SHA256.fullmatch(args.deployment_fingerprint):
        raise FaultProbeError("profile or deployment fingerprint is invalid")
    if args.expected_integrity_digest and not SHA256.fullmatch(args.expected_integrity_digest):
        raise FaultProbeError("expected integrity digest is invalid")

    evidence: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION, "probeVersion": PROBE_VERSION,
        "runId": args.run_id, "startedAt": utc_now(), "model": args.model,
        "profileFingerprint": args.profile_fingerprint,
        "deploymentFingerprint": args.deployment_fingerprint,
    }
    try:
        with HostMemorySampler(args.proc_root) as sampler:
            before = integrity(args.base_url, args.model)
            evidence["integrity"] = before
            if args.expected_integrity_digest and before["contentDigest"] != args.expected_integrity_digest:
                raise FaultProbeError("integrity digest changed across worker lifecycle")
            if not args.integrity_only:
                evidence["malformedInput"] = malformed_inputs(args.base_url, args.model)
                evidence["timeout"] = timeout_request(args.base_url, args.model)
                evidence["cancellation"] = cancel_stream(args.base_url, args.model)
                evidence["cachePressure"] = cache_pressure(args.base_url, args.model)
                after = integrity(args.base_url, args.model)
                evidence["resultIntegrity"] = {
                    "passed": after["contentDigest"] == before["contentDigest"],
                    "beforeContentDigest": before["contentDigest"],
                    "afterContentDigest": after["contentDigest"],
                    "afterResponseDigest": after["responseDigest"],
                }
                if not evidence["resultIntegrity"]["passed"]:
                    raise FaultProbeError("result integrity changed after request faults")
        evidence["resources"] = sampler.summary()
        evidence["outcome"] = "passed"
    except BaseException as error:
        evidence["outcome"] = "failed"
        evidence["failure"] = {"type": error.__class__.__name__, "message": str(error)[:500]}
    evidence["finishedAt"] = utc_now()
    evidence["evidenceDigest"] = canonical_digest(evidence)
    print(json.dumps(evidence, sort_keys=True, separators=(",", ":")))
    return 0 if evidence["outcome"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
