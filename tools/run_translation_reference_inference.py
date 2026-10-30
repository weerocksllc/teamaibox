#!/usr/bin/env python3
"""Temporarily swap NVFP4 for BF16, collect Translation reference output, and restore."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from run_spark_model_baseline import (
    BaselineError,
    IMAGE,
    Spark,
    catalog_profile,
    ensure_runtime_boundary,
    remove_server,
    require,
    server_name,
    start_server,
    wait_ready,
)


BF16_PROFILE = "llm.qwen36-35b-a3b.bf16.spark-reference-32k.v1"
NVFP4_PROFILE = "llm.qwen36-35b-a3b.nvfp4.spark-32k.v1"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--remote-staging", required=True)
    parser.add_argument("--corpus-name", required=True)
    parser.add_argument("--inference-name", required=True)
    parser.add_argument("--output-name", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--profile-fingerprint", required=True)
    args = parser.parse_args()
    if not args.remote_staging.startswith("/tmp/teamaibox-translation-quality-"):
        raise ValueError("remote staging is outside the exact Translation quality boundary")
    if any("/" in item or item in {"", ".", ".."} for item in (
        args.corpus_name, args.inference_name, args.output_name
    )):
        raise ValueError("staging filenames must be simple exact names")

    spark = Spark()
    catalog, bf16 = catalog_profile(BF16_PROFILE)
    _, nvfp4 = catalog_profile(NVFP4_PROFILE)
    ensure_runtime_boundary(spark)
    state = spark.run(["docker", "inspect", server_name(nvfp4), "--format", "{{.State.Running}}"], 30)
    if state.returncode != 0 or state.stdout.strip() != "true":
        raise BaselineError("the exact production NVFP4 worker was not running before reference maintenance")

    reference_summary: dict[str, object] | None = None
    reference_load: dict[str, object] | None = None
    restore_load: dict[str, object] | None = None
    primary_error: BaseException | None = None
    restore_error: BaseException | None = None
    try:
        require(spark.run(["docker", "stop", "--time", "60", server_name(nvfp4)], 120), "NVFP4 maintenance stop")
        start_server(spark, catalog, bf16)
        reference_load, _ = wait_ready(spark, bf16, 1200)
        output_path = f"{args.remote_staging}/{args.output_name}"
        require(spark.run(["touch", output_path], 30), "reference output creation")
        require(spark.run(["chmod", "600", output_path], 30), "reference output permissions")
        runner = "teamaibox-translation-inference-bf16-" + args.run_id
        result = require(spark.run([
            "docker", "run", "--rm", "--name", runner,
            "--label", "io.teamaibox.owner=translation-quality",
            "--label", f"io.teamaibox.run-id={args.run_id}",
            "--user", "1000:1000", "--network", "teamaibox-model-validation-internal",
            "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--memory", "4g", "--cpus", "4", "--pids-limit", "512",
            "--mount", f"type=bind,source={args.remote_staging},target=/validation",
            "--entrypoint", "python", IMAGE,
            f"/validation/{args.inference_name}",
            "--corpus", f"/validation/{args.corpus_name}",
            "--output", f"/validation/{args.output_name}",
            "--base-url", f"http://{server_name(bf16)}:8000",
            "--served-model", str(bf16["servedModelName"]),
            "--profile-key", str(bf16["profileKey"]),
            "--profile-fingerprint", args.profile_fingerprint,
            "--batch-size", "10", "--timeout-seconds", "180",
        ], 7200), "BF16 Translation inference")
        reference_summary = json.loads(result.stdout)
    except BaseException as error:
        primary_error = error
    finally:
        try:
            remove_server(spark, bf16)
            require(spark.run(["docker", "start", server_name(nvfp4)], 120), "NVFP4 production restore")
            restore_load, _ = wait_ready(spark, nvfp4, 1200)
            require(spark.run(["curl", "-kfsS", "--max-time", "10", "https://127.0.0.1:18081/"], 30), "stable Web health after restore")
        except BaseException as error:
            restore_error = error

    print(json.dumps({
        "runId": args.run_id,
        "referenceSummary": reference_summary,
        "referenceLoad": reference_load,
        "productionRestored": restore_error is None,
        "restoreLoad": restore_load,
        "primaryError": None if primary_error is None else str(primary_error)[:2000],
        "restoreError": None if restore_error is None else str(restore_error)[:2000],
    }, sort_keys=True))
    if restore_error is not None:
        return 2
    if primary_error is not None:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
