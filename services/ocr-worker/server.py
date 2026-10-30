"""Bounded PaddleOCR-VL spotting adapter for the Team AI Box OCR contract."""

from __future__ import annotations

import asyncio
import base64
from functools import lru_cache
import hashlib
import io
import json
import os
from pathlib import Path
import re
import threading
from typing import Any

import fitz
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
import httpx
from PIL import Image

from layout_onnx import LayoutBlock, LayoutDetector
from otsl import convert_otsl


SERVED_MODEL = os.environ.get("TEAMAIBOX_OCR_SERVED_MODEL", "PaddleOCR-VL-1.5-0.9B")
MODEL_ROOT = Path(os.environ.get("TEAMAIBOX_OCR_MODEL_ROOT", "/models/paddleocr-vl-1.5"))
MODEL_REVISION = os.environ.get("TEAMAIBOX_OCR_MODEL_REVISION", "df2b114327c857f4db801d3d5b6741ad9a24fcd1")
VLLM_ORIGIN = os.environ.get("TEAMAIBOX_OCR_VLLM_ORIGIN", "http://vlm:8000").rstrip("/")
LAYOUT_MODEL_ROOT = Path(os.environ.get("TEAMAIBOX_OCR_LAYOUT_MODEL_ROOT", "/models/pp-doclayout-v3"))
LAYOUT_MODEL = LAYOUT_MODEL_ROOT / "PP-DocLayoutV3.onnx"
LAYOUT_MODEL_REVISION = os.environ.get(
    "TEAMAIBOX_OCR_LAYOUT_MODEL_REVISION", "9027d49d3764d465c3d7c4e8506910fb8d9c1498"
)
LAYOUT_MODEL_SHA256 = "sha256:dc5670ebbb42e2ba4e41395fc55e8217b007134e8b9e35023d592a8fe040a288"
MAX_BODY_BYTES = 96 * 1024 * 1024
MAX_INPUT_BYTES = 64 * 1024 * 1024
MAX_PAGES = 128
MAX_PIXELS = 32_000_000
MARKDOWN_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)
LOCATION_TOKEN = re.compile(r"<\|LOC_(\d{1,4})\|>")
SPOTTING_LINE = re.compile(r"([^<\n]+?)((?:<\|LOC_\d{1,4}\|>){8})\s*(?:\n|$)")
LAYOUT_THREADS = min(16, max(1, int(os.environ.get("TEAMAIBOX_OCR_LAYOUT_THREADS", "4"))))
LAYOUT_THRESHOLD = float(os.environ.get("TEAMAIBOX_OCR_LAYOUT_THRESHOLD", "0.3"))
MAX_LAYOUT_BLOCKS = 384
TEXT_LABELS = frozenset({
    "abstract", "algorithm", "aside_text", "content", "doc_title", "figure_title",
    "footer", "footnote", "formula_number", "header", "number", "paragraph_title",
    "reference", "reference_content", "text", "vertical_text", "vision_footnote",
})
IMAGE_LABELS = frozenset({"image", "header_image", "footer_image"})

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
_layout_detector: LayoutDetector | None = None
_layout_detector_lock = threading.Lock()


def model_ready() -> bool:
    try:
        value = json.loads((MODEL_ROOT / "teamaibox-model-manifest.json").read_text(encoding="utf-8"))
        return value.get("revision") == MODEL_REVISION and value.get("precision") == "bf16"
    except (OSError, ValueError, json.JSONDecodeError):
        return False


@lru_cache(maxsize=1)
def layout_model_ready() -> bool:
    try:
        value = json.loads((LAYOUT_MODEL_ROOT / "teamaibox-model-manifest.json").read_text(encoding="utf-8"))
        files = value.get("files")
        return (
            value.get("model") == "PP-DocLayoutV3"
            and value.get("sourceRevision") == LAYOUT_MODEL_REVISION
            and files == [{"path": LAYOUT_MODEL.name, "sha256": LAYOUT_MODEL_SHA256, "size": 129_920_689}]
            and LAYOUT_MODEL.is_file()
            and LAYOUT_MODEL.stat().st_size == 129_920_689
            and "sha256:" + hashlib.file_digest(LAYOUT_MODEL.open("rb"), "sha256").hexdigest() == LAYOUT_MODEL_SHA256
        )
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return False


def layout_detector() -> LayoutDetector:
    global _layout_detector
    if _layout_detector is None:
        with _layout_detector_lock:
            if _layout_detector is None:
                if not layout_model_ready():
                    raise RuntimeError("layout model is not verified")
                _layout_detector = LayoutDetector(
                    LAYOUT_MODEL, threshold=LAYOUT_THRESHOLD, threads=LAYOUT_THREADS
                )
    return _layout_detector


def bounded_box(value: Any, width: int, height: int) -> list[float]:
    if not isinstance(value, list):
        raise ValueError("spotting bounding box is missing")
    flattened: list[Any] = []
    for item in value:
        flattened.extend(item if isinstance(item, list) else [item])
    if len(flattened) not in {4, 8} or any(isinstance(item, bool) or not isinstance(item, (int, float)) for item in flattened):
        raise ValueError("spotting bounding box is invalid")
    coordinates = [float(item) for item in flattened]
    if max(coordinates, default=0) <= 1.0:
        coordinates = [item * (width if index % 2 == 0 else height) for index, item in enumerate(coordinates)]
    if any(item < 0 for item in coordinates) or any(
        item > (width if index % 2 == 0 else height) * 1.02 for index, item in enumerate(coordinates)
    ):
        raise ValueError("spotting bounding box is outside the image")
    return [round(item, 3) for item in coordinates]


def spotting_blocks(content: str, width: int, height: int) -> list[dict[str, Any]]:
    candidate = MARKDOWN_FENCE.sub("", content.strip())
    try:
        value = json.loads(candidate)
    except json.JSONDecodeError as error:
        # PaddleOCR-VL 1.5's native spotting contract is one recognized text
        # line followed by four normalized polygon points.  Each coordinate is
        # encoded as a dedicated <|LOC_0|> ... <|LOC_1000|> token.  Preserve
        # the quadrilateral instead of collapsing it to an axis-aligned box.
        blocks = []
        for index, match in enumerate(SPOTTING_LINE.finditer(candidate)):
            text = match.group(1).strip()
            coordinates = [int(item) for item in LOCATION_TOKEN.findall(match.group(2))]
            if not text or len(coordinates) != 8 or any(item > 1000 for item in coordinates):
                raise ValueError("spotting location tokens are invalid") from error
            polygon = [
                round(item * (width if coordinate_index % 2 == 0 else height) / 1000, 3)
                for coordinate_index, item in enumerate(coordinates)
            ]
            blocks.append({"block_id": index + 1, "block_bbox": bounded_box(polygon, width, height),
                           "block_label": "text", "block_content": text, "block_score": None})
        if not blocks or LOCATION_TOKEN.sub("", SPOTTING_LINE.sub("", candidate)).strip():
            raise ValueError("spotting response is neither JSON nor valid location-token output") from error
        return blocks
    if isinstance(value, dict) and isinstance(value.get("spotting_res"), dict):
        value = value["spotting_res"]
    blocks: list[dict[str, Any]] = []
    if isinstance(value, dict):
        texts = value.get("rec_texts") or value.get("texts")
        boxes = value.get("rec_boxes") or value.get("rec_polys") or value.get("boxes")
        scores = value.get("rec_scores") or value.get("scores") or []
        if isinstance(texts, list) and isinstance(boxes, list) and len(texts) == len(boxes):
            for index, (text, box) in enumerate(zip(texts, boxes, strict=True)):
                score = scores[index] if index < len(scores) else None
                blocks.append({"block_id": index + 1, "block_bbox": bounded_box(box, width, height),
                               "block_label": "text", "block_content": text,
                               "block_score": score if isinstance(score, (int, float)) and not isinstance(score, bool) else None})
    elif isinstance(value, list):
        for index, item in enumerate(value):
            if not isinstance(item, dict):
                raise ValueError("spotting item is invalid")
            text = item.get("text") or item.get("transcription")
            box = item.get("bbox") or item.get("box") or item.get("points")
            score = item.get("score") or item.get("confidence")
            blocks.append({"block_id": index + 1, "block_bbox": bounded_box(box, width, height),
                           "block_label": "text", "block_content": text,
                           "block_score": score if isinstance(score, (int, float)) and not isinstance(score, bool) else None})
    if not blocks or len(blocks) > 100_000 or any(not isinstance(item["block_content"], str) for item in blocks):
        raise ValueError("spotting response contains no valid text blocks")
    return blocks


def input_pages(raw: bytes, file_type: int) -> list[tuple[bytes, int, int]]:
    pages: list[tuple[bytes, int, int]] = []
    if file_type == 0:
        try:
            document = fitz.open(stream=raw, filetype="pdf")
            if not 1 <= document.page_count <= MAX_PAGES:
                raise ValueError("PDF page count is invalid")
            for page in document:
                pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
                if pixmap.width * pixmap.height > MAX_PIXELS:
                    raise ValueError("rendered PDF page is too large")
                pages.append((pixmap.tobytes("png"), pixmap.width, pixmap.height))
            document.close()
        except (fitz.FileDataError, RuntimeError) as error:
            raise ValueError("PDF input is invalid") from error
    elif file_type == 1:
        try:
            image = Image.open(io.BytesIO(raw))
            image.load()
            if image.width * image.height > MAX_PIXELS or image.width < 1 or image.height < 1:
                raise ValueError("image dimensions are invalid")
            output = io.BytesIO()
            image.convert("RGB").save(output, format="PNG")
            pages.append((output.getvalue(), image.width, image.height))
        except (OSError, ValueError) as error:
            raise ValueError("image input is invalid") from error
    else:
        raise ValueError("file type is invalid")
    return pages


def recognition_prompt(label: str) -> str | None:
    if label in TEXT_LABELS:
        return "OCR:"
    if label == "table":
        return "Table Recognition:"
    if label in {"display_formula", "inline_formula"}:
        return "Formula Recognition:"
    if label == "chart":
        return "Chart Recognition:"
    if label == "seal":
        return "Seal Recognition:"
    if label in IMAGE_LABELS:
        return None
    raise ValueError("layout block label is unsupported")


def recognized_content(value: str) -> str:
    candidate = value.strip()
    if candidate.startswith("```") and candidate.endswith("```"):
        lines = candidate.splitlines()
        if len(lines) >= 3:
            candidate = "\n".join(lines[1:-1]).strip()
    if not candidate or len(candidate.encode("utf-8")) > 4 * 1024 * 1024:
        raise ValueError("VLM recognition content is invalid")
    return candidate


def structured_region(label: str, content: str) -> tuple[str, str, dict[str, Any] | None]:
    if label == "table":
        structure = convert_otsl(content)
        return structure["html"], "html", structure
    if label in {"display_formula", "inline_formula"}:
        return content, "latex", None
    if label == "chart":
        return content, "markdown", None
    return content, "text", None


def crop_region(image: Image.Image, block: LayoutBlock) -> bytes:
    x1, y1, x2, y2 = block.box
    padding = max(2, round(min(image.size) * 0.003))
    crop = image.crop((
        max(0, int(x1) - padding), max(0, int(y1) - padding),
        min(image.width, int(x2 + 0.999) + padding), min(image.height, int(y2 + 0.999) + padding),
    ))
    if crop.width < 1 or crop.height < 1 or crop.width * crop.height > MAX_PIXELS:
        raise ValueError("layout crop dimensions are invalid")
    output = io.BytesIO()
    crop.save(output, format="PNG")
    return output.getvalue()


async def recognize(client: httpx.AsyncClient, request: Request, image: bytes, width: int, height: int) -> dict[str, Any]:
    payload = {
        "model": SERVED_MODEL,
        "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(image).decode("ascii")}},
            {"type": "text", "text": "Spotting:"},
        ]}],
        "temperature": 0.0,
        "max_tokens": 8192,
    }
    task = asyncio.create_task(client.post(VLLM_ORIGIN + "/v1/chat/completions", json=payload))
    try:
        while not task.done():
            if await request.is_disconnected():
                task.cancel()
                raise asyncio.CancelledError()
            await asyncio.sleep(0.1)
        response = await task
    finally:
        if not task.done():
            task.cancel()
    if response.status_code != 200:
        raise RuntimeError(f"VLM rejected recognition with HTTP {response.status_code}")
    value = response.json()
    content = value.get("choices", [{}])[0].get("message", {}).get("content")
    if not isinstance(content, str) or len(content) > 32 * 1024 * 1024:
        raise ValueError("VLM recognition result is invalid")
    blocks = spotting_blocks(content, width, height)
    text = "\n".join(item["block_content"] for item in blocks)
    return {"prunedResult": {"width": width, "height": height, "parsing_res_list": blocks},
            "markdown": {"text": text, "images": None}, "outputImages": None}


async def recognize_region(
    client: httpx.AsyncClient, request: Request, image: bytes, prompt: str
) -> str:
    payload = {
        "model": SERVED_MODEL,
        "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(image).decode("ascii")}},
            {"type": "text", "text": prompt},
        ]}],
        "temperature": 0.0,
        "max_tokens": 8192,
    }
    task = asyncio.create_task(client.post(VLLM_ORIGIN + "/v1/chat/completions", json=payload))
    try:
        while not task.done():
            if await request.is_disconnected():
                task.cancel()
                raise asyncio.CancelledError()
            await asyncio.sleep(0.1)
        response = await task
    finally:
        if not task.done():
            task.cancel()
    if response.status_code != 200:
        raise RuntimeError(f"VLM rejected recognition with HTTP {response.status_code}")
    content = response.json().get("choices", [{}])[0].get("message", {}).get("content")
    if not isinstance(content, str):
        raise ValueError("VLM recognition response is invalid")
    return recognized_content(content)


async def recognize_page(
    client: httpx.AsyncClient, request: Request, image_bytes: bytes, width: int, height: int
) -> dict[str, Any]:
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    blocks = await asyncio.to_thread(layout_detector().detect, image)
    if not blocks or len(blocks) > MAX_LAYOUT_BLOCKS:
        raise ValueError("layout detector returned an invalid block count")
    results: list[dict[str, Any]] = []
    markdown: list[str] = []
    for index, block in enumerate(blocks, start=1):
        prompt = recognition_prompt(block.label)
        content = ""
        content_format = "none"
        structure = None
        if prompt is not None:
            content = await recognize_region(client, request, crop_region(image, block), prompt)
            content, content_format, structure = structured_region(block.label, content)
            markdown.append(content)
        result = {
            "block_id": index,
            "block_bbox": list(block.box),
            "block_label": block.label,
            "block_content": content,
            "block_format": content_format,
            "block_score": block.score,
            "reading_order": block.reading_order,
        }
        if structure is not None:
            result["block_structure"] = structure
        results.append(result)
    return {
        "prunedResult": {"width": width, "height": height, "parsing_res_list": results},
        "markdown": {"text": "\n\n".join(markdown), "images": None},
        "outputImages": None,
    }


@app.get("/health")
async def health() -> JSONResponse:
    if not model_ready() or not layout_model_ready():
        return JSONResponse({"status": "unavailable", "model": SERVED_MODEL, "accepting": False}, status_code=503)
    try:
        async with httpx.AsyncClient(timeout=2) as client:
            response = await client.get(VLLM_ORIGIN + "/health")
        accepting = response.status_code == 200
    except httpx.HTTPError:
        accepting = False
    return JSONResponse({"status": "ready" if accepting else "unavailable", "model": SERVED_MODEL,
                         "accepting": accepting, "pipeline": "pp-doclayout-v3-vlm-v1"}, status_code=200 if accepting else 503)


@app.post("/layout-parsing")
async def layout_parsing(request: Request) -> JSONResponse:
    length = request.headers.get("content-length")
    if not length or not length.isdigit() or not 2 <= int(length) <= MAX_BODY_BYTES:
        raise HTTPException(400, "request size is invalid")
    try:
        body = json.loads(await request.body())
        encoded = body.get("file")
        if not isinstance(encoded, str) or len(encoded) > 90 * 1024 * 1024:
            raise ValueError("file payload is invalid")
        raw = base64.b64decode(encoded, validate=True)
        if not 1 <= len(raw) <= MAX_INPUT_BYTES:
            raise ValueError("file payload is invalid")
        pages = input_pages(raw, body.get("fileType"))
        results = []
        async with httpx.AsyncClient(timeout=httpx.Timeout(900, connect=10), limits=httpx.Limits(max_connections=1)) as client:
            for image, width, height in pages:
                results.append(await recognize_page(client, request, image, width, height))
        return JSONResponse({"logId": "redacted", "errorCode": 0, "errorMsg": "Success",
                             "result": {"layoutParsingResults": results}})
    except asyncio.CancelledError:
        raise
    except (ValueError, json.JSONDecodeError) as error:
        return JSONResponse({"errorCode": 400, "errorMsg": str(error)}, status_code=400)
    except (httpx.HTTPError, RuntimeError):
        return JSONResponse({"errorCode": 502, "errorMsg": "OCR inference failed"}, status_code=502)
