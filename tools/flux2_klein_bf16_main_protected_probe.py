#!/usr/bin/env python3
"""Probe the warm protected FLUX.2 BF16 Worker through its real image API."""

from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
from pathlib import Path
import time
import urllib.error
import urllib.request
import uuid
from typing import Any


PROMPT = (
    "A clean office illustration of a compact green edge AI appliance on a pale wood desk, "
    "soft daylight, no text"
)


class ProbeError(RuntimeError):
    pass


def require(value: bool, message: str) -> None:
    if not value:
        raise ProbeError(message)


def call(base_url: str, path: str, body: dict[str, Any] | None = None,
         timeout: int = 1800, *, token: str | None = None,
         owner_id: str | None = None) -> tuple[int, dict[str, Any]]:
    raw = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    request = urllib.request.Request(
        base_url.rstrip("/") + path,
        data=raw,
        headers={
            **({"content-type": "application/json"} if raw is not None else {}),
            **({"authorization": "Bearer " + token} if token is not None else {}),
            **({"x-teamaibox-owner": owner_id} if owner_id is not None else {}),
        },
        method="POST" if raw is not None else "GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def request_body(model: str, job_id: str, seed: int) -> dict[str, Any]:
    return {
        "model": model, "prompt": PROMPT, "n": 1, "size": "512x512",
        "response_format": "b64_json",
        "x_teamaibox": {
            "job_id": job_id, "seed": seed, "steps": 4,
            "guidance_scale": 1.0, "preset_key": "drawing.office.protected.v1",
        },
    }


def image_facts(encoded: str, inference_metrics: dict[str, Any] | None = None) -> dict[str, Any]:
    raw = bytearray(base64.b64decode(encoded, validate=True))
    try:
        from PIL import Image, ImageStat
        with Image.open(io.BytesIO(raw)) as opened:
            image = opened.convert("RGB")
        statistics = ImageStat.Stat(image)
        variance = sum(statistics.var) / 3
        if image.size != (512, 512) or variance < 80:
            diagnostic = {
                "width": image.width,
                "height": image.height,
                "meanChannelVariance": round(variance, 6),
                "channelExtrema": statistics.extrema,
                "channelMeans": [round(value, 6) for value in statistics.mean],
                "inferenceMetrics": inference_metrics,
            }
            raise ProbeError(
                "generated image is visually empty: "
                + json.dumps(diagnostic, sort_keys=True, separators=(",", ":"))
            )
        return {
            "bytes": len(raw), "sha256": "sha256:" + hashlib.sha256(raw).hexdigest(),
            "width": image.width, "height": image.height,
            "meanChannelVariance": round(variance, 6),
            "inferenceMetrics": inference_metrics,
        }
    finally:
        raw[:] = b"\0" * len(raw)


def run(base_url: str, model: str, cycle: int, token: str, owner_id: str,
        maximum_warm_first_image_ms: int) -> dict[str, Any]:
    require(cycle in {1, 2} and model == "flux2-klein-4b-bf16", "probe identity is invalid")
    require(len(token) >= 43 and not any(character.isspace() for character in token),
            "probe bearer token is invalid")
    require(uuid.UUID(owner_id).version in {1, 2, 3, 4, 5, 6, 7, 8},
            "probe owner identity is invalid")
    require(maximum_warm_first_image_ms == 120_000,
            "protected BF16 warm first-image latency boundary drifted")
    started = time.monotonic()
    unauthorized_status, unauthorized = call(base_url, "/health", timeout=10)
    require(unauthorized_status == 401
            and unauthorized.get("error", {}).get("code") == "worker_unauthorized",
            "protected BF16 Worker accepted an unauthenticated request")
    status, health = call(base_url, "/health", timeout=10, token=token)
    require(status == 200
            and health.get("status") == "ready"
            and health.get("model") == model
            and health.get("loaded") is True
            and health.get("warm") is True
            and health.get("placement_class") == "protected-resident"
            and health.get("idle_unload") is False
            and health.get("ordinary_drain_allowed") is False
            and health.get("maximum_concurrent_requests") == 1
            and health.get("operations") == ["images.generations"]
            and health.get("precision") == "bf16"
            and health.get("fatal_cuda") is False
            and health.get("wall_clock_timeout_seconds") == 600
            and health.get("job_tombstone_capacity") == 4096
            and health.get("memory_strategy", {}).get("mode")
            == "leaf-level-group-offload-to-dedicated-disk-volume-with-resident-vae"
            and health.get("memory_strategy", {}).get("components")
            == ["transformer", "text_encoder"]
            and health.get("memory_strategy", {}).get("resident_components") == ["vae"]
            and health.get("memory_strategy", {}).get("offload_type") == "leaf_level"
            and health.get("memory_strategy", {}).get("offload_to_disk") is True
            and health.get("memory_strategy", {}).get("use_stream") is False
            and health.get("memory_strategy", {}).get("low_cpu_memory_usage") is True
            and health.get("memory_strategy", {}).get("offload_file_count", 0) > 0
            and health.get("kv_cache") == {
                "applicability": "not-applicable-image-diffusion-pipeline",
                "explicit_bytes": None,
            }, "protected BF16 warm health contract drifted")
    models_status, models = call(base_url, "/v1/models", timeout=10, token=token)
    require(models_status == 200
            and [item.get("id") for item in models.get("data", [])] == [model]
            and models["data"][0].get("x_teamaibox", {}).get("precision") == "bf16",
            "protected BF16 model disclosure drifted")
    job_scope = f"teamaibox:flux2-bf16:{owner_id}:{cycle}"
    generation_id = str(uuid.uuid5(uuid.NAMESPACE_URL, job_scope + ":generation"))
    first_image_started = time.monotonic()
    status, generated = call(base_url, "/v1/images/generations",
                             request_body(model, generation_id, 44001),
                             token=token, owner_id=owner_id)
    first_image_milliseconds = round((time.monotonic() - first_image_started) * 1000)
    encoded = (generated.get("data") or [{}])[0].get("b64_json")
    extension = generated.get("x_teamaibox") or {}
    require(status == 200 and isinstance(encoded, str)
            and extension.get("precision") == "bf16"
            and extension.get("placement_class") == "protected-resident"
            and extension.get("steps") == 4
            and extension.get("guidance_scale") == 1.0,
            "protected BF16 generation protocol failed")
    require(0 < first_image_milliseconds <= maximum_warm_first_image_ms,
            "protected BF16 warm first-image latency exceeded product usability bound")
    generated_facts = image_facts(encoded, extension.get("inference_metrics"))

    cancel_id = str(uuid.uuid5(uuid.NAMESPACE_URL, job_scope + ":cancel"))
    blocked_id = str(uuid.uuid5(uuid.NAMESPACE_URL, job_scope + ":blocked"))
    with ThreadPoolExecutor(max_workers=2) as executor:
        pending = executor.submit(
            call, base_url, "/v1/images/generations",
            request_body(model, cancel_id, 45000 + cycle), 1800,
            token=token, owner_id=owner_id,
        )
        deadline = time.monotonic() + 30
        active = False
        while time.monotonic() < deadline:
            health_status, active_health = call(base_url, "/health", timeout=10, token=token)
            if health_status == 200 and active_health.get("active_jobs") == 1:
                active = True
                break
            if pending.done():
                break
            time.sleep(0.05)
        require(active, "protected BF16 active cancellation window was not observed")
        busy_status, busy = call(
            base_url, "/v1/images/generations", request_body(model, blocked_id, 46000 + cycle),
            30, token=token, owner_id=owner_id,
        )
        other_owner = str(uuid.uuid5(uuid.NAMESPACE_URL, f"teamaibox:flux2-bf16:{cycle}:other"))
        foreign_status, foreign = call(
            base_url, f"/v1/images/generations/{cancel_id}/cancel", {}, 30,
            token=token, owner_id=other_owner,
        )
        cancel_status, cancelled = call(
            base_url, f"/v1/images/generations/{cancel_id}/cancel", {}, 30,
            token=token, owner_id=owner_id,
        )
        result_status, result = pending.result(timeout=1800)
    require(busy_status == 429
            and busy.get("error", {}).get("code") == "maximum_concurrency_exceeded",
            "protected BF16 maximum concurrency one was not enforced")
    require(foreign_status == 403
            and foreign.get("error", {}).get("code") == "job_owner_mismatch",
            "protected BF16 job ownership was not enforced")
    require(cancel_status == 200 and cancelled.get("cancelled") is True
            and result_status == 409
            and result.get("error", {}).get("code") == "worker_cancelled",
            "protected BF16 cooperative cancellation failed")
    recovery_id = str(uuid.uuid5(
        uuid.NAMESPACE_URL, job_scope + ":post-cancel-recovery"
    ))
    recovery_status, recovery = call(
        base_url, "/v1/images/generations", request_body(model, recovery_id, 44001), 1800,
        token=token, owner_id=owner_id,
    )
    recovery_encoded = (recovery.get("data") or [{}])[0].get("b64_json")
    require(recovery_status == 200 and isinstance(recovery_encoded, str),
            "protected BF16 generation did not recover after cancellation")
    recovery_facts = image_facts(recovery_encoded)
    require(recovery_facts["sha256"] == generated_facts["sha256"],
            "protected BF16 post-cancel deterministic recovery drifted")
    late_cancel_status, late_cancel = call(
        base_url, f"/v1/images/generations/{recovery_id}/cancel", {}, 30,
        token=token, owner_id=owner_id,
    )
    require(late_cancel_status == 200 and late_cancel.get("cancelled") is False
            and late_cancel.get("state") == "succeeded",
            "protected BF16 late cancellation crossed the completion linearization point")
    edit_status, edit = call(base_url, "/v1/images/edits", {"model": model}, 30,
                             token=token, owner_id=owner_id)
    require(edit_status == 400 and edit.get("error", {}).get("code") == "unsupported_operation",
            "protected BF16 generation-only boundary drifted")
    unload_status, unload = call(base_url, "/v1/models/unload", {}, 30,
                                 token=token, owner_id=owner_id)
    require(unload_status == 409
            and unload.get("error", {}).get("code") == "protected_resident_unload_forbidden",
            "protected BF16 ordinary unload was not denied")
    final_status, final_health = call(base_url, "/health", timeout=10, token=token)
    require(final_status == 200 and final_health.get("loaded") is True
            and final_health.get("active_jobs") == 0,
            "protected BF16 runtime was not warm after protocol probes")
    return {
        "schemaVersion": 1,
        "runnerId": "teamaibox.flux2-klein-bf16-main-protected-probe.v1",
        "passed": True, "cycle": cycle, "model": model,
        "modelsEndpoint": {"httpStatus": models_status, "ids": [model]},
        "generation": {"passed": True, "output": generated_facts,
                       "steps": 4, "guidanceScale": 1.0,
                       "wallClockMilliseconds": first_image_milliseconds,
                       "maximumAllowedMilliseconds": maximum_warm_first_image_ms},
        "cancellation": {"passed": True, "activeWindowObserved": True,
                         "httpStatus": result_status, "ownerBound": True,
                         "foreignOwnerDeniedHttpStatus": foreign_status,
                         "lateCancellationLinearized": True},
        "postCancellationRecovery": {
            "passed": True, "httpStatus": recovery_status, "output": recovery_facts,
            "matchesInitialGeneration": True,
        },
        "concurrency": {"passed": True, "maximumConcurrentRequests": 1,
                        "rejectionHttpStatus": busy_status},
        "generationOnly": {"passed": True, "editHttpStatus": edit_status},
        "protectedResidency": {"passed": True, "unloadHttpStatus": unload_status,
                               "warmAfterProbe": True},
        "authentication": {"passed": True, "bearerRequired": True,
                           "unauthenticatedHttpStatus": unauthorized_status,
                           "credentialRetained": False},
        "watchdog": {"wallClockTimeoutSeconds": 600, "fatalCudaReadiness": True},
        "kvCache": health["kv_cache"],
        "contentRetained": False, "syntheticPromptsOnly": True,
        "durationSeconds": time.monotonic() - started,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--cycle", type=int, required=True)
    parser.add_argument("--token-file", type=Path, required=True)
    parser.add_argument("--owner-id", required=True)
    parser.add_argument("--maximum-warm-first-image-ms", type=int, required=True)
    args = parser.parse_args()
    try:
        token = args.token_file.read_text(encoding="ascii").strip()
        value = run(args.base_url, args.model, args.cycle, token, args.owner_id,
                    args.maximum_warm_first_image_ms)
    except Exception as error:
        value = {
            "schemaVersion": 1,
            "runnerId": "teamaibox.flux2-klein-bf16-main-protected-probe.v1",
            "passed": False, "cycle": args.cycle, "model": args.model,
            "contentRetained": False, "syntheticPromptsOnly": True,
            "failure": {"type": type(error).__name__, "message": str(error)[:1200]},
        }
    print(json.dumps(value, sort_keys=True, separators=(",", ":")))
    return 0 if value["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
