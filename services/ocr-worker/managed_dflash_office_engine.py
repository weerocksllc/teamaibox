#!/usr/bin/env python3
"""Private HunyuanOCR 1.5 inference engine used by the managed Worker."""

from __future__ import annotations

import base64
import binascii
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

try:
    from services.media_io.resources import buffered_bytes, document_pages
except ModuleNotFoundError:
    from media_resources import buffered_bytes, document_pages


SERVED_MODEL = os.environ.get("TEAMAIBOX_HUNYUAN_SERVED_MODEL", "hunyuanocr-1.5-bf16-dflash")
MODEL_REVISION = os.environ.get("MODEL_REVISION", "")
def input_budget():
    return buffered_bytes(configured=os.environ.get("TEAMAIBOX_HUNYUAN_MAX_INPUT_BYTES"))

def request_budget():
    return buffered_bytes(configured=os.environ.get("TEAMAIBOX_HUNYUAN_MAX_BODY_BYTES"))

JOB_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
PROMPT = (
    "提取文档图片中正文的所有信息用markdown格式表示，其中页眉、页脚部分忽略，"
    "表格用html格式表达，文档中公式用latex格式表示，按照阅读顺序组织进行解析。"
)
RUNTIME: Any | None = None
INFERENCE_WARMED = False
OFFICE_KV_CACHE_BYTES = 1342177280


class RequestError(ValueError):
    pass


def media_type(content: bytes, file_type: int) -> tuple[str, str]:
    if file_type == 0 and content.startswith(b"%PDF"):
        return "application/pdf", ".pdf"
    if file_type == 1 and content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", ".png"
    if file_type == 1 and content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", ".jpg"
    if file_type == 1 and len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "image/webp", ".webp"
    raise RequestError("OCR fileType does not match PDF, PNG, JPEG, or WebP bytes")


def normalize_page(markdown: str) -> dict[str, Any]:
    if not isinstance(markdown, str):
        raise RuntimeError("HunyuanOCR returned invalid Markdown")
    block = {
        "block_id": "markdown-1", "block_content": markdown, "block_bbox": None,
        "confidence": None, "block_label": "text", "block_format": "markdown",
        "reading_order": 0, "geometry_supported": False,
    }
    return {
        "prunedResult": {"width": None, "height": None, "geometry_supported": False,
                         "parsing_res_list": [block]},
        "markdown": {"text": markdown, "images": None}, "outputImages": None,
    }


def load_runtime() -> Any:
    global RUNTIME
    if os.environ.get("INFERENCE_MODE") != "vllm-dflash":
        raise RuntimeError("managed HunyuanOCR requires INFERENCE_MODE=vllm-dflash")
    if int(os.environ.get("DFLASH_NUM_SPECULATIVE_TOKENS", "0")) != 15:
        raise RuntimeError("managed HunyuanOCR requires the qualified DFlash width of 15")
    from worker_hunyuanocr.ocr_runtime import get_runtime
    runtime = get_runtime()
    if runtime.inference_mode != "vllm-dflash":
        raise RuntimeError("HunyuanOCR silently selected a non-DFlash runtime")
    RUNTIME = runtime
    return runtime


def warm_inference() -> None:
    """Warm the actual image/prompt/decode path before advertising readiness."""
    global INFERENCE_WARMED
    if RUNTIME is None or RUNTIME.inference_mode != "vllm-dflash":
        raise RuntimeError("office_dflash_runtime_unavailable")
    config = RUNTIME.model.llm_engine.vllm_config
    if config.cache_config.kv_cache_memory_bytes != OFFICE_KV_CACHE_BYTES \
            or config.scheduler_config.max_num_seqs != 1 \
            or config.model_config.max_model_len != 8192:
        raise RuntimeError("office_ocr_memory_policy_drift")
    from PIL import Image, ImageDraw, ImageFont
    from worker_hunyuanocr.ocr_runtime import generate_markdown_batch
    with tempfile.TemporaryDirectory(prefix="ocr-office-warmup-", dir="/tmp") as directory:
        path = Path(directory) / "synthetic.png"
        with Image.new("RGB", (1200, 300), "white") as image:
            draw = ImageDraw.Draw(image)
            font = ImageFont.load_default(size=48)
            draw.text((40, 40), "TEAM AI BOX READY", fill="black", font=font)
            draw.text((40, 130), "Invoice 20260910 Total 128.50", fill="black", font=font)
            image.save(path)
        results = generate_markdown_batch([(path, PROMPT)])
        if len(results) != 1 or not isinstance(results[0][0], str) or not results[0][0].strip():
            raise RuntimeError("office_ocr_warmup_failed")
    INFERENCE_WARMED = True


def recognize(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value).difference({
        "model", "job_id", "file", "fileType", "useLayoutDetection", "formatBlockContent",
        "layoutShapeMode", "returnMarkdownImages", "visualize", "language_hints",
    }):
        raise RequestError("OCR request fields are invalid")
    if value.get("model") != SERVED_MODEL or value.get("fileType") not in {0, 1}:
        raise RequestError("OCR model or fileType is invalid")
    if value.get("returnMarkdownImages") not in {None, False} or value.get("visualize") not in {None, False}:
        raise RequestError("embedded images and visualization are unsupported")
    job_id = value.get("job_id")
    if not isinstance(job_id, str) or not JOB_ID.fullmatch(job_id):
        raise RequestError("OCR job identity is invalid")
    encoded = value.get("file")
    if not isinstance(encoded, str) or len(encoded) < 4 or len(encoded) > request_budget():
        raise RequestError("OCR input is empty or exceeds currently available memory")
    try:
        content = bytearray(base64.b64decode(encoded, validate=True))
    except (ValueError, binascii.Error) as error:
        raise RequestError("OCR input base64 is invalid") from error
    if not content or len(content) > input_budget():
        content[:] = b"\0" * len(content)
        raise RequestError("OCR input is empty or exceeds currently available memory")
    _, extension = media_type(content, value["fileType"])
    workspace = Path(tempfile.mkdtemp(prefix=f"ocr-{job_id}-", dir="/tmp"))
    source = workspace / ("source" + extension)
    started = time.monotonic()
    try:
        source.write_bytes(content)
        content[:] = b"\0" * len(content)
        from worker_hunyuanocr.ocr_runtime import generate_markdown_batch
        results = []
        # Keep only one rendered page and one model request in memory.
        pages = document_pages(source, workspace, pdf=extension == ".pdf")
        try:
            for path in pages:
                generated = generate_markdown_batch([(path, PROMPT)])
                if len(generated) != 1:
                    raise RuntimeError("HunyuanOCR returned an unexpected page count")
                results.append(normalize_page(generated[0][0]))
        finally:
            pages.close()
        runtime = RUNTIME
        if runtime is None or runtime.inference_mode != "vllm-dflash":
            raise RuntimeError("DFlash runtime identity was lost")
        return {
            "errorCode": 0, "errorMsg": "Success",
            "result": {"layoutParsingResults": results},
            "x_teamaibox": {
                "model": SERVED_MODEL, "model_revision": MODEL_REVISION,
                "inference_mode": runtime.inference_mode, "backend_version": runtime.backend_version,
                "dflash_num_speculative_tokens": 15,
                "duration_ms": round((time.monotonic() - started) * 1000),
                "page_count": len(results), "geometry_supported": False,
                "html_tables_preserved_in_markdown": True,
                "latex_formulas_preserved_in_markdown": True,
            },
        }
    finally:
        content[:] = b"\0" * len(content)
        shutil.rmtree(workspace, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "TeamAIBoxHunyuanDFlashEngine/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def send_json(self, status: int, value: Any) -> None:
        raw = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self.send_json(200, {"status": "ready", "model": SERVED_MODEL, "loaded": RUNTIME is not None and INFERENCE_WARMED,
                                 "inference_warmed": INFERENCE_WARMED,
                                 "kv_cache_memory_bytes": OFFICE_KV_CACHE_BYTES, "max_num_seqs": 1,
                                 "inference_mode": getattr(RUNTIME, "inference_mode", None)})
        else:
            self.send_json(404, {"error": {"code": "not_found"}})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/ocr":
            self.send_json(404, {"error": {"code": "not_found"}})
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
            if length < 2 or length > request_budget():
                raise RequestError("OCR request is empty or exceeds currently available memory")
            value = json.loads(self.rfile.read(length))
            self.send_json(200, recognize(value))
        except (RequestError, json.JSONDecodeError, UnicodeDecodeError) as error:
            self.send_json(400, {"error": {"code": "invalid_ocr_request", "message": str(error)}})
        except Exception:
            self.send_json(500, {"error": {"code": "hunyuan_dflash_failed"}})


def main() -> int:
    load_runtime()
    warm_inference()
    server = ThreadingHTTPServer(("127.0.0.1", 8001), Handler)
    server.daemon_threads = True
    server.serve_forever(poll_interval=0.25)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
