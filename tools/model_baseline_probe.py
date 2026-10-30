#!/usr/bin/env python3
"""Run a bounded, content-safe OpenAI-compatible LLM baseline probe.

The probe is intended to run in a disposable container on the appliance. It
uses only Python's standard library, never stores response text, and reports
only response digests, deterministic assertions, timing, token counts, and
aggregate machine counters.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import math
import os
import pathlib
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Mapping, Sequence


PROBE_VERSION = "1.0.0"
SCHEMA_VERSION = 1
DEFAULT_TIMEOUT_SECONDS = 300
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
SAFE_RUN_ID = re.compile(r"^[a-z0-9][a-z0-9-]{7,63}$")
SHA256 = re.compile(r"^sha256:[a-f0-9]{64}$")
SAFE_INTERNAL_ENDPOINT = re.compile(r"^http://(?:127\.0\.0\.1|teamaibox-model-[a-z0-9-]{3,80}):[1-9][0-9]{1,4}$")


class ProbeError(RuntimeError):
    pass


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def canonical_digest(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return sha256_bytes(encoded)


def percentile(values: Sequence[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return round(ordered[lower], 3)
    return round(ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower), 3)


def parse_meminfo(text: str) -> dict[str, int]:
    values: dict[str, int] = {}
    names = {"MemTotal": "totalBytes", "MemAvailable": "availableBytes"}
    for line in text.splitlines():
        key, separator, raw = line.partition(":")
        if not separator or key not in names:
            continue
        parts = raw.strip().split()
        if not parts or not parts[0].isdigit():
            continue
        multiplier = 1024 if len(parts) > 1 and parts[1].lower() == "kb" else 1
        values[names[key]] = int(parts[0]) * multiplier
    if set(values) != {"totalBytes", "availableBytes"} or values["availableBytes"] > values["totalBytes"]:
        raise ProbeError("host memory telemetry is unavailable")
    values["usedBytes"] = values["totalBytes"] - values["availableBytes"]
    return values


def parse_cpu_stat(text: str) -> tuple[int, int]:
    first = text.splitlines()[0].split() if text else []
    if len(first) < 5 or first[0] != "cpu":
        raise ProbeError("host CPU telemetry is unavailable")
    fields = [int(item) for item in first[1:]]
    total = sum(fields[:8])
    idle = fields[3] + (fields[4] if len(fields) > 4 else 0)
    return total, idle


def cpu_busy_percent(before: tuple[int, int], after: tuple[int, int]) -> float:
    total = max(0, after[0] - before[0])
    idle = max(0, after[1] - before[1])
    if total == 0:
        return 0.0
    return round(max(0.0, min(100.0, (total - idle) * 100.0 / total)), 3)


def parse_netdev(text: str) -> tuple[int, int]:
    received = transmitted = 0
    for line in text.splitlines()[2:]:
        if ":" not in line:
            continue
        _name, raw = line.split(":", 1)
        fields = raw.split()
        if len(fields) >= 9 and fields[0].isdigit() and fields[8].isdigit():
            received += int(fields[0])
            transmitted += int(fields[8])
    return received, transmitted


def parse_diskstats(text: str) -> tuple[int, int]:
    read_sectors = write_sectors = 0
    for line in text.splitlines():
        fields = line.split()
        if len(fields) < 14:
            continue
        name = fields[2]
        if name.startswith(("loop", "ram", "zram", "dm-")) or re.search(r"(?:p|\d)\d+$", name):
            continue
        try:
            read_sectors += int(fields[5])
            write_sectors += int(fields[9])
        except ValueError:
            continue
    return read_sectors * 512, write_sectors * 512


def _read(path: pathlib.Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (FileNotFoundError, PermissionError, OSError, UnicodeError) as error:
        raise ProbeError(f"telemetry source is unavailable: {path.name}") from error


def _nvidia_sample() -> dict[str, float | str]:
    query = "utilization.gpu,temperature.gpu,power.draw"
    try:
        completed = subprocess.run(
            ["nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader,nounits"],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
            env={"PATH": os.environ.get("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"), "LC_ALL": "C"},
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return {"status": "unsupported", "reason": "nvidia_smi_unavailable"}
    if completed.returncode != 0 or not completed.stdout.strip():
        return {"status": "unsupported", "reason": "nvidia_query_unsupported"}
    raw = [part.strip() for part in completed.stdout.splitlines()[0].split(",")]
    if len(raw) != 3:
        return {"status": "unsupported", "reason": "nvidia_query_unparseable"}
    try:
        return {"status": "measured", "utilizationPercent": float(raw[0]), "temperatureCelsius": float(raw[1]), "powerWatts": float(raw[2])}
    except ValueError:
        return {"status": "unsupported", "reason": "nvidia_query_unparseable"}


@dataclass(frozen=True)
class CounterSnapshot:
    monotonic: float
    memory: Mapping[str, int]
    cpu: tuple[int, int]
    disk: tuple[int, int]
    network: tuple[int, int]
    nvidia: Mapping[str, float | str]


class ResourceSampler:
    def __init__(self, proc_root: pathlib.Path, interval_seconds: float = 0.2):
        self.proc_root = proc_root
        self.interval_seconds = interval_seconds
        self.samples: list[CounterSnapshot] = []
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def snapshot(self) -> CounterSnapshot:
        return CounterSnapshot(
            monotonic=time.monotonic(),
            memory=parse_meminfo(_read(self.proc_root / "meminfo")),
            cpu=parse_cpu_stat(_read(self.proc_root / "stat")),
            disk=parse_diskstats(_read(self.proc_root / "diskstats")),
            network=parse_netdev(_read(self.proc_root / "net" / "dev")),
            nvidia=_nvidia_sample(),
        )

    def __enter__(self) -> "ResourceSampler":
        self.samples = [self.snapshot()]
        self._stop.clear()

        def collect() -> None:
            while not self._stop.wait(self.interval_seconds):
                try:
                    self.samples.append(self.snapshot())
                except ProbeError:
                    pass

        self._thread = threading.Thread(target=collect, name="resource-sampler", daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        self.samples.append(self.snapshot())

    def summary(self) -> dict[str, Any]:
        if len(self.samples) < 2:
            raise ProbeError("resource sample is incomplete")
        first, last = self.samples[0], self.samples[-1]
        measured_gpu = [sample.nvidia for sample in self.samples if sample.nvidia.get("status") == "measured"]
        nvidia: dict[str, Any]
        if measured_gpu:
            nvidia = {
                "status": "measured",
                "acceleratorUtilizationPercentMean": round(sum(float(item["utilizationPercent"]) for item in measured_gpu) / len(measured_gpu), 3),
                "temperatureCelsiusPeak": max(float(item["temperatureCelsius"]) for item in measured_gpu),
                "powerWattsPeak": max(float(item["powerWatts"]) for item in measured_gpu),
            }
        else:
            nvidia = dict(self.samples[-1].nvidia)
        return {
            "sampleCount": len(self.samples),
            "durationMs": round((last.monotonic - first.monotonic) * 1000, 3),
            "peakHostUnifiedMemoryUsedBytes": max(sample.memory["usedBytes"] for sample in self.samples),
            "minimumHostAvailableMemoryBytes": min(sample.memory["availableBytes"] for sample in self.samples),
            "cpuBusyPercent": cpu_busy_percent(first.cpu, last.cpu),
            "diskReadBytes": max(0, last.disk[0] - first.disk[0]),
            "diskWriteBytes": max(0, last.disk[1] - first.disk[1]),
            "networkReceiveBytes": max(0, last.network[0] - first.network[0]),
            "networkTransmitBytes": max(0, last.network[1] - first.network[1]),
            "nvidia": nvidia,
        }


def _post_json(url: str, body: Mapping[str, Any], timeout_seconds: int) -> urllib.response.addinfourl:
    request = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "text/event-stream, application/json"},
    )
    return urllib.request.urlopen(request, timeout=timeout_seconds)


def _safe_error(error: BaseException) -> str:
    if isinstance(error, urllib.error.HTTPError):
        return f"http_{error.code}"
    if isinstance(error, urllib.error.URLError):
        return "connection_error"
    if isinstance(error, TimeoutError):
        return "timeout"
    return re.sub(r"[^a-z0-9_]+", "_", error.__class__.__name__.lower())[:64]


def chat_request(
    *, base_url: str, model: str, messages: Sequence[Mapping[str, str]], max_tokens: int,
    timeout_seconds: int, stream: bool = True, seed: int = 1337,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": model,
        "messages": list(messages),
        "max_tokens": max_tokens,
        "temperature": 0,
        "seed": seed,
        "stream": stream,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    if stream:
        payload["stream_options"] = {"include_usage": True}
    started = time.monotonic()
    first_result: float | None = None
    response_parts: list[str] = []
    usage: dict[str, int] = {}
    response_bytes = 0
    try:
        with _post_json(base_url.rstrip("/") + "/v1/chat/completions", payload, timeout_seconds) as response:
            if stream:
                for raw_line in response:
                    response_bytes += len(raw_line)
                    if response_bytes > MAX_RESPONSE_BYTES:
                        raise ProbeError("response exceeded safe evidence limit")
                    line = raw_line.strip()
                    if not line.startswith(b"data:"):
                        continue
                    data = line[5:].strip()
                    if data == b"[DONE]":
                        break
                    event = json.loads(data)
                    if isinstance(event.get("usage"), dict):
                        usage = {key: int(value) for key, value in event["usage"].items() if isinstance(value, int)}
                    for choice in event.get("choices", []):
                        delta = choice.get("delta", {})
                        part = delta.get("content") or delta.get("reasoning_content") or ""
                        if part:
                            if first_result is None:
                                first_result = time.monotonic()
                            response_parts.append(str(part))
            else:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                if len(raw) > MAX_RESPONSE_BYTES:
                    raise ProbeError("response exceeded safe evidence limit")
                event = json.loads(raw)
                first_result = time.monotonic()
                usage = {key: int(value) for key, value in event.get("usage", {}).items() if isinstance(value, int)}
                for choice in event.get("choices", []):
                    message = choice.get("message", {})
                    response_parts.append(str(message.get("content") or message.get("reasoning_content") or ""))
    except BaseException as error:  # converted to a stable, content-free classification
        return {"outcome": "error", "classification": _safe_error(error), "durationMs": round((time.monotonic() - started) * 1000, 3)}
    finished = time.monotonic()
    content = "".join(response_parts).strip()
    completion_tokens = usage.get("completion_tokens", 0)
    duration = max(finished - started, 1e-9)
    generation_duration = max(finished - (first_result or started), 1e-9)
    return {
        "outcome": "completed",
        "durationMs": round(duration * 1000, 3),
        "ttftMs": round(((first_result or finished) - started) * 1000, 3),
        "completionTokens": completion_tokens,
        "promptTokens": usage.get("prompt_tokens", 0),
        "tokenThroughputPerSecond": round(completion_tokens / generation_duration, 3),
        "responseDigest": sha256_bytes(content.encode("utf-8")),
        "responseText": content,
    }


QUALITY_CASES: tuple[dict[str, Any], ...] = (
    {"caseId": "arithmetic", "prompt": "Return only the integer result of 37*19+11.", "maxTokens": 32, "check": lambda value: value.strip() == "714"},
    {"caseId": "json_instruction", "prompt": 'Return only this JSON object with no markdown: {"ok":true,"count":3}', "maxTokens": 48, "check": lambda value: _json_equals(value, {"ok": True, "count": 3})},
    {"caseId": "ordered_primes", "prompt": "Return only the first five prime numbers separated by commas, with no spaces.", "maxTokens": 32, "check": lambda value: value.strip() == "2,3,5,7,11"},
    {"caseId": "simplified_chinese", "prompt": "Translate into Simplified Chinese. Return only the translation: Private AI appliances protect team data.", "maxTokens": 64, "check": lambda value: "数据" in value and any(term in value for term in ("保护", "保障"))},
)


def _json_equals(value: str, expected: Any) -> bool:
    try:
        return json.loads(value.strip()) == expected
    except json.JSONDecodeError:
        return False


def public_result(result: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in result.items() if key != "responseText"}


def run_quality(base_url: str, model: str, timeout_seconds: int) -> dict[str, Any]:
    results = []
    for item in QUALITY_CASES:
        response = chat_request(
            base_url=base_url, model=model,
            messages=[{"role": "system", "content": "Follow the user's output format exactly."}, {"role": "user", "content": item["prompt"]}],
            max_tokens=item["maxTokens"], timeout_seconds=timeout_seconds,
        )
        passed = response.get("outcome") == "completed" and bool(item["check"](response.get("responseText", "")))
        results.append({"caseId": item["caseId"], "passed": passed, **public_result(response)})
    return {
        "suiteKey": "llm.baseline-smoke.v1",
        "inputSetDigest": canonical_digest([{key: value for key, value in item.items() if key != "check"} for item in QUALITY_CASES]),
        "passed": all(item["passed"] for item in results),
        "passedCases": sum(1 for item in results if item["passed"]),
        "totalCases": len(results),
        "cases": results,
        "scope": "bounded_reference_smoke_not_certification_suite",
    }


def _one_benchmark(base_url: str, model: str, context: str, output_tokens: int, timeout_seconds: int) -> dict[str, Any]:
    return chat_request(
        base_url=base_url, model=model,
        messages=[{"role": "user", "content": context + "\nReturn a concise numbered summary."}],
        max_tokens=output_tokens, timeout_seconds=timeout_seconds,
    )


def run_wave(
    *, base_url: str, model: str, requests: int, concurrency: int, context: str,
    output_tokens: int, timeout_seconds: int,
) -> dict[str, Any]:
    started = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = [executor.submit(_one_benchmark, base_url, model, context, output_tokens, timeout_seconds) for _ in range(requests)]
        results = [future.result() for future in futures]
    duration = max(time.monotonic() - started, 1e-9)
    completed = [item for item in results if item.get("outcome") == "completed"]
    valid = [item for item in completed if item.get("completionTokens", 0) > 0 and item.get("ttftMs", 0) > 0]
    return {
        "requests": requests,
        "concurrency": concurrency,
        "completed": len(completed),
        "errors": len(results) - len(completed),
        "invalidMeasurements": len(completed) - len(valid),
        "wallTimeMs": round(duration * 1000, 3),
        "requestThroughputPerSecond": round(len(completed) / duration, 3),
        "tokenThroughputPerSecond": round(sum(item.get("completionTokens", 0) for item in completed) / duration, 3),
        "promptTokensMinimum": min((item.get("promptTokens", 0) for item in completed), default=0),
        "ttftMsP50": percentile([item["ttftMs"] for item in completed], 0.5),
        "ttftMsP95": percentile([item["ttftMs"] for item in completed], 0.95),
        "latencyMsP50": percentile([item["durationMs"] for item in completed], 0.5),
        "latencyMsP95": percentile([item["durationMs"] for item in completed], 0.95),
        "results": [public_result(item) for item in results],
    }


def run_benchmarks(base_url: str, model: str, timeout_seconds: int) -> list[dict[str, Any]]:
    short_context = "DGX Spark combines CPU and accelerator memory in one coherent memory pool."
    long_context = ("Edge AI keeps private workloads close to the team and schedules scarce compute carefully. " * 900).strip()
    definitions = (
        ("warm_single", 3, 1, short_context, 96, False),
        ("dynamic_batch_four", 4, 2, short_context, 96, False),
        ("concurrency_two", 6, 2, short_context, 96, False),
        ("long_context", 3, 1, long_context, 64, True),
    )
    reports = []
    for key, requests, concurrency, context, output_tokens, long_context_flag in definitions:
        warmup = _one_benchmark(base_url, model, context, min(output_tokens, 32), timeout_seconds)
        report = run_wave(
            base_url=base_url, model=model, requests=requests, concurrency=concurrency,
            context=context, output_tokens=output_tokens, timeout_seconds=timeout_seconds,
        )
        report.update({
            "scenarioKey": key,
            "warmupExcluded": public_result(warmup),
            "contextPayloadBytes": len(context.encode("utf-8")),
            "outputTokenLimit": output_tokens,
            "longContext": long_context_flag,
        })
        reports.append(report)
    return reports


def run_stability(base_url: str, model: str, timeout_seconds: int, requests: int) -> dict[str, Any]:
    started = time.monotonic()
    failures: dict[str, int] = {}
    latencies: list[float] = []
    for index in range(requests):
        response = chat_request(
            base_url=base_url, model=model,
            messages=[{"role": "user", "content": f"Return only OK. Stability sample {index + 1}."}],
            max_tokens=16, timeout_seconds=timeout_seconds,
        )
        if response.get("outcome") == "completed":
            latencies.append(response["durationMs"])
        else:
            key = str(response.get("classification", "unknown_error"))
            failures[key] = failures.get(key, 0) + 1
    return {
        "requested": requests,
        "completed": len(latencies),
        "failed": requests - len(latencies),
        "failureClassifications": failures,
        "durationMs": round((time.monotonic() - started) * 1000, 3),
        "latencyMsP50": percentile(latencies, 0.5),
        "latencyMsP95": percentile(latencies, 0.95),
        "scope": "bounded_stability_probe_not_eight_hour_soak",
    }


def validate_args(args: argparse.Namespace) -> None:
    if not SAFE_RUN_ID.fullmatch(args.run_id):
        raise ProbeError("run ID is invalid")
    if not SHA256.fullmatch(args.profile_fingerprint) or not SHA256.fullmatch(args.deployment_fingerprint):
        raise ProbeError("profile or deployment fingerprint is invalid")
    if not SAFE_INTERNAL_ENDPOINT.fullmatch(args.base_url):
        raise ProbeError("baseline probe endpoint must be appliance loopback or the isolated model network")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{2,255}", args.model):
        raise ProbeError("model name is invalid")


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--profile-fingerprint", required=True)
    parser.add_argument("--deployment-fingerprint", required=True)
    parser.add_argument("--load-time-ms", required=True, type=float)
    parser.add_argument("--proc-root", type=pathlib.Path, default=pathlib.Path("/host-proc"))
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--stability-requests", type=int, default=20)
    args = parser.parse_args(list(argv) if argv is not None else None)
    validate_args(args)
    if args.load_time_ms <= 0 or not math.isfinite(args.load_time_ms):
        raise ProbeError("load time must be a positive finite value")
    if not 3 <= args.stability_requests <= 1000 or not 1 <= args.timeout_seconds <= 1800:
        raise ProbeError("probe bounds are invalid")

    started_at = utc_now()
    with ResourceSampler(args.proc_root) as sampler:
        quality = run_quality(args.base_url, args.model, args.timeout_seconds)
        benchmarks = run_benchmarks(args.base_url, args.model, args.timeout_seconds)
        stability = run_stability(args.base_url, args.model, args.timeout_seconds, args.stability_requests)
    resources = sampler.summary()
    completed = sum(item["completed"] for item in benchmarks)
    errors = sum(item["errors"] for item in benchmarks)
    invalid = sum(item["invalidMeasurements"] for item in benchmarks)
    long_context_passed = all(item["promptTokensMinimum"] >= 8192 for item in benchmarks if item["longContext"])
    passed = quality["passed"] and errors == 0 and invalid == 0 and long_context_passed and stability["failed"] == 0
    evidence = {
        "schemaVersion": SCHEMA_VERSION,
        "probeVersion": PROBE_VERSION,
        "runId": args.run_id,
        "profileFingerprint": args.profile_fingerprint,
        "deploymentFingerprint": args.deployment_fingerprint,
        "model": args.model,
        "startedAt": started_at,
        "finishedAt": utc_now(),
        "loadTimeMs": round(args.load_time_ms, 3),
        "quality": quality,
        "benchmarks": benchmarks,
        "stability": stability,
        "resources": resources,
        "summary": {
            "outcome": "passed" if passed else "failed",
            "benchmarkCompletedRequests": completed,
            "benchmarkErrors": errors,
            "benchmarkInvalidMeasurements": invalid,
            "longContextMinimumReached": long_context_passed,
            "certificationClaimEligible": False,
            "reason": "initial_baseline_evidence_requires_remaining_certification_stages",
        },
    }
    evidence["evidenceDigest"] = canonical_digest(evidence)
    print(json.dumps(evidence, ensure_ascii=False, sort_keys=True, indent=2))
    return 0 if passed else 2


if __name__ == "__main__":
    raise SystemExit(main())
