#!/usr/bin/env python3
"""Run a resumable, content-safe long-duration OpenAI model soak."""

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
import socket
import sqlite3
import statistics
import subprocess
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Iterable


SCHEMA_VERSION = 1
PROBE_VERSION = "1.0.0"
SAFE_ENDPOINT = re.compile(r"^http://teamaibox-model-[a-z0-9-]{3,80}:8000$")
SAFE_MODEL = re.compile(r"^[a-z0-9][a-z0-9._-]{2,100}$")
SAFE_RUN_ID = re.compile(r"^[a-z0-9][a-z0-9-]{7,63}$")
SHA256 = re.compile(r"^sha256:[a-f0-9]{64}$")
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MARKER = "OK"


class SoakError(RuntimeError):
    pass


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_utc(value: str) -> dt.datetime:
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def digest_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def canonical_digest(value: Any) -> str:
    return digest_bytes(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


def percentile(values: Iterable[float], fraction: float) -> float | None:
    ordered = sorted(values)
    if not ordered:
        return None
    position = (len(ordered) - 1) * fraction
    lower, upper = math.floor(position), math.ceil(position)
    if lower == upper:
        return round(ordered[lower], 3)
    return round(ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower), 3)


def job_id(run_id: str, index: int) -> str:
    return "soak-" + hashlib.sha256(f"{run_id}:{index}".encode()).hexdigest()[:32]


def read_host_memory(proc_root: pathlib.Path) -> dict[str, int]:
    try:
        lines = (proc_root / "meminfo").read_text(encoding="utf-8").splitlines()
        values = {line.split(":", 1)[0]: int(line.split()[1]) * 1024 for line in lines if line.startswith(("MemTotal:", "MemAvailable:"))}
    except (OSError, UnicodeError, ValueError, IndexError) as error:
        raise SoakError("host unified-memory evidence is unavailable") from error
    if set(values) != {"MemTotal", "MemAvailable"} or not 0 < values["MemAvailable"] <= values["MemTotal"]:
        raise SoakError("host unified-memory evidence is invalid")
    return {"totalBytes": values["MemTotal"], "availableBytes": values["MemAvailable"], "usedBytes": values["MemTotal"] - values["MemAvailable"]}


def nvidia_sample() -> dict[str, Any]:
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=utilization.gpu,temperature.gpu,power.draw", "--format=csv,noheader,nounits"],
            text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False, timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {"status": "unsupported", "reason": "nvidia_smi_unavailable"}
    fields = [item.strip() for item in result.stdout.splitlines()[0].split(",")] if result.returncode == 0 and result.stdout.strip() else []
    try:
        utilization, temperature, power = (float(item) for item in fields)
    except (ValueError, TypeError):
        return {"status": "unsupported", "reason": "nvidia_query_unavailable"}
    return {"status": "measured", "utilizationPercent": utilization, "temperatureCelsius": temperature, "powerWatts": power}


def health(base_url: str) -> bool:
    try:
        with urllib.request.urlopen(base_url + "/health", timeout=10) as response:
            return response.status == 200
    except (urllib.error.URLError, TimeoutError, socket.timeout):
        return False


def execute_request(base_url: str, model: str, prompt: str, timeout_seconds: int = 300) -> dict[str, Any]:
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "Follow the user's output format exactly."},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 16,
        "temperature": 0,
        "seed": 1337,
        "stream": False,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    request = urllib.request.Request(
        base_url + "/v1/chat/completions",
        data=json.dumps(payload, separators=(",", ":")).encode(),
        method="POST", headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if response.status != 200 or len(raw) > MAX_RESPONSE_BYTES:
                raise SoakError("model response exceeded the bounded HTTP contract")
        document = json.loads(raw)
        content = document["choices"][0]["message"]["content"].strip()
        usage = document.get("usage") if isinstance(document.get("usage"), dict) else {}
        provider_id = document.get("id")
        if content != MARKER or not isinstance(provider_id, str) or not provider_id:
            raise SoakError("model response failed the deterministic integrity contract")
        return {
            "outcome": "completed", "latencyMs": round((time.monotonic() - started) * 1000, 3),
            "promptTokens": usage.get("prompt_tokens", 0), "completionTokens": usage.get("completion_tokens", 0),
            "contentDigest": digest_bytes(content.encode()), "providerResponseId": provider_id,
        }
    except BaseException as error:
        if isinstance(error, SoakError):
            classification = str(error)
        elif isinstance(error, urllib.error.HTTPError):
            classification = f"http_{error.code}"
        elif isinstance(error, (urllib.error.URLError, TimeoutError, socket.timeout)):
            classification = "transport_or_timeout"
        else:
            classification = error.__class__.__name__.lower()
        return {"outcome": "failed", "latencyMs": round((time.monotonic() - started) * 1000, 3), "classification": re.sub(r"[^a-z0-9_]+", "_", classification.lower())[:96]}


class Journal:
    def __init__(self, path: pathlib.Path, run_id: str, started_at: str):
        self.connection = sqlite3.connect(path)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=FULL")
        self.connection.executescript("""
          CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS jobs (
            job_index INTEGER PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
            submitted_at TEXT NOT NULL, completed_at TEXT, latency_ms REAL,
            prompt_tokens INTEGER, completion_tokens INTEGER, content_digest TEXT,
            provider_response_id TEXT, error_classification TEXT
          );
        """)
        existing = self.connection.execute("SELECT value FROM metadata WHERE key='run_id'").fetchone()
        if existing and existing[0] != run_id:
            raise SoakError("soak journal belongs to a different run")
        self.connection.execute("INSERT OR IGNORE INTO metadata(key,value) VALUES('run_id',?)", (run_id,))
        self.connection.execute("INSERT OR IGNORE INTO metadata(key,value) VALUES('started_at',?)", (started_at,))
        self.connection.commit()
        self.lock = threading.Lock()

    def metadata(self, key: str) -> str:
        row = self.connection.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
        if not row:
            raise SoakError("soak journal metadata is incomplete")
        return row[0]

    def next_index(self) -> int:
        row = self.connection.execute("SELECT COALESCE(MAX(job_index),-1)+1 FROM jobs").fetchone()
        return int(row[0])

    def submit(self, index: int, identity: str) -> None:
        with self.lock:
            self.connection.execute("INSERT INTO jobs(job_index,job_id,state,submitted_at) VALUES(?,?,?,?)", (index, identity, "submitted", utc_now()))
            self.connection.commit()

    def complete(self, index: int, result: dict[str, Any]) -> None:
        with self.lock:
            if result["outcome"] == "completed":
                cursor = self.connection.execute(
                    "UPDATE jobs SET state='completed',completed_at=?,latency_ms=?,prompt_tokens=?,completion_tokens=?,content_digest=?,provider_response_id=? WHERE job_index=? AND state='submitted'",
                    (utc_now(), result["latencyMs"], result["promptTokens"], result["completionTokens"], result["contentDigest"], result["providerResponseId"], index),
                )
            else:
                cursor = self.connection.execute(
                    "UPDATE jobs SET state='failed',completed_at=?,latency_ms=?,error_classification=? WHERE job_index=? AND state='submitted'",
                    (utc_now(), result["latencyMs"], result["classification"], index),
                )
            if cursor.rowcount != 1:
                raise SoakError("soak journal completion was duplicated or lost")
            self.connection.commit()

    def counts(self) -> dict[str, int]:
        rows = dict(self.connection.execute("SELECT state,COUNT(*) FROM jobs GROUP BY state"))
        submitted = sum(rows.values())
        return {"submitted": submitted, "completed": rows.get("completed", 0), "failed": rows.get("failed", 0), "incomplete": rows.get("submitted", 0)}

    def window(self, since: str) -> dict[str, Any]:
        rows = self.connection.execute("SELECT latency_ms,prompt_tokens,completion_tokens FROM jobs WHERE state='completed' AND completed_at>=?", (since,)).fetchall()
        latencies = [float(row[0]) for row in rows]
        return {
            "completed": len(rows), "latencyMsP50": percentile(latencies, 0.5), "latencyMsP95": percentile(latencies, 0.95),
            "promptTokens": sum(int(row[1]) for row in rows), "completionTokens": sum(int(row[2]) for row in rows),
        }

    def integrity(self, run_id: str) -> dict[str, Any]:
        rows = self.connection.execute("SELECT job_index,job_id,state,content_digest,provider_response_id FROM jobs ORDER BY job_index").fetchall()
        expected = hashlib.sha256()
        completed = hashlib.sha256()
        provider_ids: set[str] = set()
        duplicates = 0
        for index, identity, state, content_digest, provider_id in rows:
            expected.update((job_id(run_id, int(index)) + "\n").encode())
            if identity != job_id(run_id, int(index)):
                raise SoakError("soak journal job identity drifted")
            if state == "completed":
                completed.update((identity + "\n").encode())
                if content_digest != digest_bytes(MARKER.encode()):
                    raise SoakError("soak journal result digest drifted")
                if provider_id in provider_ids:
                    duplicates += 1
                provider_ids.add(provider_id)
        counts = self.counts()
        lost = counts["submitted"] - counts["completed"] - counts["failed"] - counts["incomplete"]
        return {
            "expectedJobSequenceDigest": "sha256:" + expected.hexdigest(),
            "completedJobSequenceDigest": "sha256:" + completed.hexdigest(),
            "lostJobs": lost, "duplicateProviderResponses": duplicates,
        }

    def all_completed_rows(self) -> list[tuple[str, float]]:
        return [(row[0], float(row[1])) for row in self.connection.execute("SELECT completed_at,latency_ms FROM jobs WHERE state='completed' ORDER BY completed_at")]

    def close(self) -> None:
        self.connection.close()


def atomic_json(path: pathlib.Path, value: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def linear_memory_growth(samples: list[dict[str, Any]]) -> float:
    if len(samples) < 2:
        return 0.0
    xs = [(parse_utc(item["observedAt"]) - parse_utc(samples[0]["observedAt"])).total_seconds() / 3600 for item in samples]
    ys = [float(item["memory"]["usedBytes"]) for item in samples]
    mean_x, mean_y = statistics.fmean(xs), statistics.fmean(ys)
    denominator = sum((value - mean_x) ** 2 for value in xs)
    return 0.0 if denominator == 0 else sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys)) / denominator


def analyze(
    samples: list[dict[str, Any]], journal: Journal, duration_seconds: int,
    reserve_bytes: int, *, enforce_long_duration_trends: bool,
) -> dict[str, Any]:
    if len(samples) < 2:
        raise SoakError("soak time series is incomplete")
    memory = [item["memory"] for item in samples]
    first_count = min(30, max(1, len(memory) // 4))
    first_available = statistics.median(item["availableBytes"] for item in memory[:first_count])
    last_available = statistics.median(item["availableBytes"] for item in memory[-first_count:])
    growth = max(0, int(first_available - last_available))
    slope = linear_memory_growth(samples)
    measured_gpu = [item["nvidia"] for item in samples if item["nvidia"].get("status") == "measured"]
    rows = journal.all_completed_rows()
    split = max(1, len(rows) // 10)
    first_latency = [value for _, value in rows[:split]]
    last_latency = [value for _, value in rows[-split:]]
    elapsed_seconds = max(0.0, (dt.datetime.now(dt.timezone.utc) - parse_utc(journal.metadata("started_at"))).total_seconds())
    elapsed_hours = max(elapsed_seconds / 3600, 1 / 3600)
    first_elapsed = max((parse_utc(rows[split - 1][0]) - parse_utc(rows[0][0])).total_seconds(), 1) if rows else 1
    last_elapsed = max((parse_utc(rows[-1][0]) - parse_utc(rows[-split][0])).total_seconds(), 1) if rows else 1
    first_rate, last_rate = len(first_latency) / first_elapsed, len(last_latency) / last_elapsed
    throughput_degradation = 0.0 if first_rate == 0 else max(0.0, (first_rate - last_rate) / first_rate)
    first_p95, last_p95 = percentile(first_latency, 0.95), percentile(last_latency, 0.95)
    latency_increase = 0.0 if not first_p95 else max(0.0, ((last_p95 or 0) - first_p95) / first_p95)
    counts = journal.counts()
    integrity = journal.integrity(journal.metadata("run_id"))
    acceptance = {
        "durationReached": elapsed_seconds >= duration_seconds - 1,
        "allJobsCompleted": counts["submitted"] > 0 and counts["failed"] == 0 and counts["incomplete"] == 0,
        "noLostOrDuplicatedJobs": integrity["lostJobs"] == 0 and integrity["duplicateProviderResponses"] == 0 and integrity["expectedJobSequenceDigest"] == integrity["completedJobSequenceDigest"],
        "healthStable": all(item["healthPassed"] for item in samples),
        "coreReservePreserved": min(item["availableBytes"] for item in memory) >= reserve_bytes,
        "boundedMemoryGrowth": growth <= 4 * 1024**3 and (not enforce_long_duration_trends or slope <= 512 * 1024**2),
        "thermalBounded": not measured_gpu or max(item["temperatureCelsius"] for item in measured_gpu) <= 90,
        "throughputStable": not enforce_long_duration_trends or throughput_degradation <= 0.20,
        "latencyStable": not enforce_long_duration_trends or latency_increase <= 0.50,
    }
    return {
        "passed": all(acceptance.values()), "acceptance": acceptance,
        "longDurationTrendGateApplied": enforce_long_duration_trends,
        "elapsedHours": round(elapsed_hours, 6), "jobs": {**counts, **integrity},
        "memory": {
            "minimumAvailableBytes": min(item["availableBytes"] for item in memory),
            "firstWindowMedianAvailableBytes": int(first_available), "lastWindowMedianAvailableBytes": int(last_available),
            "growthBytes": growth, "linearGrowthBytesPerHour": round(slope, 3),
        },
        "thermal": {
            "status": "measured" if measured_gpu else "unsupported",
            "peakTemperatureCelsius": max((item["temperatureCelsius"] for item in measured_gpu), default=None),
            "peakPowerWatts": max((item["powerWatts"] for item in measured_gpu), default=None),
            "meanUtilizationPercent": round(statistics.fmean(item["utilizationPercent"] for item in measured_gpu), 3) if measured_gpu else None,
        },
        "performance": {
            "firstWindowRequestsPerSecond": round(first_rate, 6), "lastWindowRequestsPerSecond": round(last_rate, 6),
            "throughputDegradationFraction": round(throughput_degradation, 6),
            "firstWindowLatencyMsP95": first_p95, "lastWindowLatencyMsP95": last_p95,
            "latencyIncreaseFraction": round(latency_increase, 6),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--profile-fingerprint", required=True)
    parser.add_argument("--deployment-fingerprint", required=True)
    parser.add_argument("--suite-digest", required=True)
    parser.add_argument("--configuration-digest", required=True)
    parser.add_argument("--probe-source-digest", required=True)
    parser.add_argument("--duration-seconds", type=int, required=True)
    parser.add_argument("--request-interval-seconds", type=float, default=5)
    parser.add_argument("--sample-interval-seconds", type=float, default=60)
    parser.add_argument("--long-every-jobs", type=int, default=12)
    parser.add_argument("--core-reserve-bytes", type=int, required=True)
    parser.add_argument("--proc-root", type=pathlib.Path, default=pathlib.Path("/host-proc"))
    parser.add_argument("--evidence-dir", type=pathlib.Path, default=pathlib.Path("/evidence"))
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args()
    if not SAFE_ENDPOINT.fullmatch(args.base_url) or not SAFE_MODEL.fullmatch(args.model) or not SAFE_RUN_ID.fullmatch(args.run_id):
        raise SoakError("soak endpoint, model, or run identity is invalid")
    if any(not SHA256.fullmatch(value) for value in (
        args.profile_fingerprint, args.deployment_fingerprint, args.suite_digest,
        args.configuration_digest, args.probe_source_digest,
    )):
        raise SoakError("soak lineage fingerprint is invalid")
    if not 60 <= args.duration_seconds <= 26 * 3600 or not 1 <= args.request_interval_seconds <= 60 or not 10 <= args.sample_interval_seconds <= 60 or not 2 <= args.long_every_jobs <= 1000 or args.core_reserve_bytes < 1024**3:
        raise SoakError("soak execution bounds are invalid")
    if args.smoke and args.duration_seconds > 900:
        raise SoakError("soak smoke duration is invalid")
    args.evidence_dir.mkdir(parents=True, exist_ok=True)
    journal = Journal(args.evidence_dir / "jobs.sqlite3", args.run_id, utc_now())
    started_at = journal.metadata("started_at")
    deadline = parse_utc(started_at) + dt.timedelta(seconds=args.duration_seconds)
    samples_path = args.evidence_dir / "samples.json"
    samples = json.loads(samples_path.read_text(encoding="utf-8")) if samples_path.is_file() else []
    next_index = journal.next_index()
    next_sample = time.monotonic()
    short_prompt = "Return only OK."
    # The same 900-repeat corpus produced about 14.4k prompt tokens in the
    # pinned baseline. A two-request burst once per minute therefore exercises
    # long-context KV/cache behavior throughout the soak without approaching
    # the 32k profile ceiling.
    long_prompt = ("Edge AI keeps private workloads close to the team and schedules scarce compute carefully. " * 900) + "Return only OK."
    failure: dict[str, str] | None = None
    try:
        while dt.datetime.now(dt.timezone.utc) < deadline:
            batch_size = 2 if next_index > 0 and next_index % args.long_every_jobs == 0 else 1
            indices = list(range(next_index, next_index + batch_size))
            for index in indices:
                journal.submit(index, job_id(args.run_id, index))
            prompt = long_prompt if batch_size == 2 else short_prompt
            with concurrent.futures.ThreadPoolExecutor(max_workers=batch_size) as executor:
                results = list(executor.map(lambda _index: execute_request(args.base_url, args.model, prompt), indices))
            for index, result in zip(indices, results):
                journal.complete(index, result)
            next_index += batch_size
            now_monotonic = time.monotonic()
            if now_monotonic >= next_sample:
                observed_at = utc_now()
                sample = {
                    "ordinal": len(samples) + 1, "observedAt": observed_at,
                    "memory": read_host_memory(args.proc_root), "nvidia": nvidia_sample(),
                    "healthPassed": health(args.base_url), "jobs": journal.counts(),
                    "window": journal.window((parse_utc(observed_at) - dt.timedelta(seconds=args.sample_interval_seconds)).isoformat().replace("+00:00", "Z")),
                }
                samples.append(sample)
                atomic_json(samples_path, samples)
                checkpoint = {
                    "schemaVersion": SCHEMA_VERSION, "probeVersion": PROBE_VERSION, "runId": args.run_id,
                    "startedAt": started_at, "checkpointAt": observed_at, "deadlineAt": deadline.isoformat().replace("+00:00", "Z"),
                    "profileFingerprint": args.profile_fingerprint, "deploymentFingerprint": args.deployment_fingerprint,
                    "suiteDigest": args.suite_digest, "configurationDigest": args.configuration_digest,
                    "probeSourceDigest": args.probe_source_digest,
                    "sampleCount": len(samples), "jobs": journal.counts(), "minimumHostAvailableMemoryBytes": min(item["memory"]["availableBytes"] for item in samples),
                }
                checkpoint["checkpointDigest"] = canonical_digest(checkpoint)
                atomic_json(args.evidence_dir / "checkpoint.json", checkpoint)
                next_sample = now_monotonic + args.sample_interval_seconds
            remaining = (deadline - dt.datetime.now(dt.timezone.utc)).total_seconds()
            if remaining > 0:
                time.sleep(min(args.request_interval_seconds, remaining))
    except BaseException as error:
        failure = {"type": error.__class__.__name__, "message": str(error)[:500]}
    finally:
        if not samples or parse_utc(samples[-1]["observedAt"]) < dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=max(2, args.sample_interval_seconds / 2)):
            observed_at = utc_now()
            samples.append({
                "ordinal": len(samples) + 1, "observedAt": observed_at,
                "memory": read_host_memory(args.proc_root), "nvidia": nvidia_sample(),
                "healthPassed": health(args.base_url), "jobs": journal.counts(),
                "window": journal.window((parse_utc(observed_at) - dt.timedelta(seconds=args.sample_interval_seconds)).isoformat().replace("+00:00", "Z")),
            })
            atomic_json(samples_path, samples)
    result: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION, "probeVersion": PROBE_VERSION, "runId": args.run_id,
        "startedAt": started_at, "finishedAt": utc_now(), "requestedDurationSeconds": args.duration_seconds,
        "profileFingerprint": args.profile_fingerprint, "deploymentFingerprint": args.deployment_fingerprint,
        "suiteDigest": args.suite_digest, "configurationDigest": args.configuration_digest,
        "probeSourceDigest": args.probe_source_digest,
        "workload": {
            "requestIntervalSeconds": args.request_interval_seconds, "sampleIntervalSeconds": args.sample_interval_seconds,
            "longEveryJobs": args.long_every_jobs, "maximumConcurrency": 2,
            "retainPromptOrOutputText": False,
        },
        "sampleCount": len(samples), "timeSeriesDigest": canonical_digest(samples),
    }
    if failure:
        result["outcome"], result["failure"] = "failed", failure
    else:
        analysis = analyze(
            samples, journal, args.duration_seconds, args.core_reserve_bytes,
            enforce_long_duration_trends=not args.smoke,
        )
        result["analysis"] = analysis
        result["outcome"] = "passed" if analysis["passed"] else "failed"
    result["evidenceDigest"] = canonical_digest(result)
    atomic_json(args.evidence_dir / "final.json", result)
    journal.close()
    print(json.dumps({"outcome": result["outcome"], "evidenceDigest": result["evidenceDigest"]}, sort_keys=True, separators=(",", ":")))
    return 0 if result["outcome"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
