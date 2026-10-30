"""Security-hardened request boundary for the immutable full OCR implementation."""

from __future__ import annotations

import asyncio
import base64
import io
import json
import math
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

import server as base


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


def hardened_input_pages(raw: bytes, file_type: int) -> list[tuple[bytes, int, int]]:
    pages: list[tuple[bytes, int, int]] = []
    if file_type == 0:
        try:
            document = base.fitz.open(stream=raw, filetype="pdf")
            if not 1 <= document.page_count <= base.MAX_PAGES:
                raise ValueError("PDF page count is invalid")
            for page in document:
                width = math.ceil(float(page.rect.width) * 2)
                height = math.ceil(float(page.rect.height) * 2)
                if width < 1 or height < 1 or width * height > base.MAX_PIXELS:
                    raise ValueError("rendered PDF page is too large")
                pixmap = page.get_pixmap(matrix=base.fitz.Matrix(2, 2), alpha=False)
                if pixmap.width * pixmap.height > base.MAX_PIXELS:
                    raise ValueError("rendered PDF page is too large")
                pages.append((pixmap.tobytes("png"), pixmap.width, pixmap.height))
            document.close()
        except (base.fitz.FileDataError, RuntimeError) as error:
            raise ValueError("PDF input is invalid") from error
    elif file_type == 1:
        try:
            image = base.Image.open(io.BytesIO(raw))
            if image.width < 1 or image.height < 1 or image.width * image.height > base.MAX_PIXELS:
                raise ValueError("image dimensions are invalid")
            image.load()
            output = io.BytesIO()
            image.convert("RGB").save(output, format="PNG")
            pages.append((output.getvalue(), image.width, image.height))
        except (OSError, ValueError, base.Image.DecompressionBombError) as error:
            raise ValueError("image input is invalid") from error
    else:
        raise ValueError("file type is invalid")
    return pages


@app.get("/health")
async def health() -> JSONResponse:
    return await base.health()


@app.post("/layout-parsing")
async def layout_parsing(request: Request) -> JSONResponse:
    media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media_type != "application/json":
        raise HTTPException(415, "content type must be application/json")
    length = request.headers.get("content-length")
    if not length or not length.isdigit() or not 2 <= int(length) <= base.MAX_BODY_BYTES:
        raise HTTPException(400, "request size is invalid")
    try:
        raw_body = await request.body()
        if len(raw_body) != int(length) or len(raw_body) > base.MAX_BODY_BYTES:
            raise ValueError("request size is invalid")
        body: Any = json.loads(raw_body)
        if not isinstance(body, dict) or set(body) != {"file", "fileType"}:
            raise ValueError("request schema is invalid")
        encoded = body.get("file")
        if not isinstance(encoded, str) or len(encoded) > 90 * 1024 * 1024:
            raise ValueError("file payload is invalid")
        raw = base64.b64decode(encoded, validate=True)
        if not 1 <= len(raw) <= base.MAX_INPUT_BYTES:
            raise ValueError("file payload is invalid")
        pages = hardened_input_pages(raw, body.get("fileType"))
        results = []
        async with base.httpx.AsyncClient(
            timeout=base.httpx.Timeout(900, connect=10), limits=base.httpx.Limits(max_connections=1)
        ) as client:
            for image, width, height in pages:
                results.append(await base.recognize_page(client, request, image, width, height))
        return JSONResponse({"logId": "redacted", "errorCode": 0, "errorMsg": "Success",
                             "result": {"layoutParsingResults": results}})
    except asyncio.CancelledError:
        raise
    except (ValueError, TypeError, json.JSONDecodeError) as error:
        return JSONResponse({"errorCode": 400, "errorMsg": str(error)}, status_code=400)
    except (base.httpx.HTTPError, RuntimeError):
        return JSONResponse({"errorCode": 502, "errorMsg": "OCR inference failed"}, status_code=502)
