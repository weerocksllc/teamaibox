#!/usr/bin/env python3
"""Content-safe protocol probe executed inside the retained OCR Provider image."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import ssl
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def request(url, token, ca_file, body=None, timeout=920, method=None):
    encoded = canonical(body) if body is not None else None
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if encoded is not None:
        headers["Content-Type"] = "application/json"
    value = urllib.request.Request(url, data=encoded, headers=headers, method=method or ("POST" if body is not None else "GET"))
    context = ssl.create_default_context(cafile=ca_file)
    try:
        with urllib.request.urlopen(value, timeout=timeout, context=context) as response:
            return response.status, json.loads(response.read(64 * 1024 * 1024 + 1))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read(1024 * 1024))


def docs_tasks():
    with urllib.request.urlopen("http://127.0.0.1:9200/docfarm/api/v1/tasks?limit=1000", timeout=10) as response:
        value = json.load(response)
    return value.get("items", [])


def marker_tasks(job_id):
    return [item for item in docs_tasks() if item.get("metadata", {}).get("request_id") == job_id]


def request_body(path, job_id, model):
    raw = path.read_bytes()
    try:
        if raw.startswith(b"%PDF-"):
            file_type = 0
        elif raw.startswith((b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff")) or (len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"):
            file_type = 1
        else:
            raise RuntimeError("fixture media is unsupported")
        return {
            "model": model, "job_id": job_id, "file": base64.b64encode(raw).decode(), "fileType": file_type,
            "useLayoutDetection": True, "formatBlockContent": True, "layoutShapeMode": "rect",
            "returnMarkdownImages": False, "visualize": False, "language_hints": ["zh-CN", "en"],
        }, "sha256:" + hashlib.sha256(raw).hexdigest(), len(raw)
    finally:
        mutable = bytearray(raw)
        mutable[:] = b"\0" * len(mutable)


def recognize(arguments, token):
    body, input_digest, input_bytes = request_body(Path(arguments.fixture), arguments.job_id, arguments.model)
    started = time.monotonic()
    status, value = request(f"{arguments.origin}/ocr", token, arguments.ca_file, body)
    elapsed = round((time.monotonic() - started) * 1000)
    pages = value.get("result", {}).get("layoutParsingResults", [])
    markdown = "\n\n".join(page.get("markdown", {}).get("text", "") for page in pages)
    if status != 200 or value.get("errorCode") != 0 or not markdown:
        error_code = value.get("error", {}).get("code") if isinstance(value, dict) else None
        raise RuntimeError(f"OCR request failed safely with HTTP {status} and code {error_code}")
    pruned = pages[0].get("prunedResult", {})
    blocks = pruned.get("parsing_res_list", [])
    if pruned.get("geometry_supported") is not False or pruned.get("width") is not None or pruned.get("height") is not None:
        raise RuntimeError("OCR response fabricated geometry capability")
    if not blocks or any(block.get("block_bbox") is not None or block.get("geometry_supported") is not False for block in blocks):
        raise RuntimeError("OCR response geometry block contract is invalid")
    if marker_tasks(arguments.job_id):
        raise RuntimeError("OCR adapter retained its exact docs-farm task")
    facts = value.get("x_teamaibox", {})
    return {
        "passed": True, "inputDigest": input_digest, "inputBytes": input_bytes,
        "textDigest": "sha256:" + hashlib.sha256(markdown.encode()).hexdigest(), "textCharacters": len(markdown),
        "pageCount": len(pages), "blockCount": sum(len(page.get("prunedResult", {}).get("parsing_res_list", [])) for page in pages),
        "geometrySupported": False, "structuredTables": facts.get("structured_tables"), "latexFormulas": facts.get("latex_formulas"),
        "modelRevision": facts.get("model_revision"), "workerImageDigest": facts.get("worker_image_digest"),
        "inferenceMode": facts.get("inference_mode"), "backendVersion": facts.get("backend_version"),
        "upstreamDurationMilliseconds": facts.get("duration_ms"), "roundTripMilliseconds": elapsed,
        "exactTaskResidue": 0,
    }


def cancellation(arguments, token):
    body, input_digest, input_bytes = request_body(Path(arguments.fixture), arguments.job_id, arguments.model)
    response = {}
    def submit():
        response["status"], response["value"] = request(f"{arguments.origin}/ocr", token, arguments.ca_file, body)
    thread = threading.Thread(target=submit, daemon=True)
    thread.start()
    observed = None
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        matches = marker_tasks(arguments.job_id)
        if matches:
            observed = matches[0]
            break
        if not thread.is_alive():
            break
        time.sleep(0.1)
    if observed is None:
        raise RuntimeError("OCR task completed before cancellation could be observed")
    cancel_status, cancel_value = request(f"{arguments.origin}/ocr/{arguments.job_id}/cancel", token, arguments.ca_file, timeout=10, method="POST")
    thread.join(30)
    if thread.is_alive():
        raise RuntimeError("cancelled OCR request did not terminate")
    deadline = time.monotonic() + 15
    while marker_tasks(arguments.job_id) and time.monotonic() < deadline:
        time.sleep(0.2)
    residue = len(marker_tasks(arguments.job_id))
    if cancel_status != 200 or cancel_value.get("cancellation_requested") is not True or response.get("status") not in {502, 503, 504} or residue:
        raise RuntimeError("OCR cancellation or exact cleanup did not complete")
    return {
        "passed": True, "inputDigest": input_digest, "inputBytes": input_bytes,
        "observedState": observed.get("status"), "cancelHttpStatus": cancel_status,
        "requestHttpStatus": response.get("status"), "exactTaskResidue": residue,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("recognize", "cancel"), required=True)
    parser.add_argument("--origin", default="https://127.0.0.1:19094/v1")
    parser.add_argument("--ca-file", default="/run/secrets/tls/ca.crt")
    parser.add_argument("--token-file", default="/run/secrets/auth/provider.token")
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--model", default="hunyuanocr-bf16-dflash")
    arguments = parser.parse_args()
    token = Path(arguments.token_file).read_text().strip()
    result = recognize(arguments, token) if arguments.mode == "recognize" else cancellation(arguments, token)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
