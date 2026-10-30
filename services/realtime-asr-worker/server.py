#!/usr/bin/env python3
"""Bounded OpenAI-style CPU worker for realtime speech chunks."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse
from faster_whisper import WhisperModel
import uvicorn

from media_contract import probe_media, validated_clip, decoded_audio_budget
from media_resources import available_memory


MODEL_DIRECTORY = Path(os.environ.get("ASR_MODEL_DIRECTORY", "/models/faster-whisper-small"))
MODEL_ALIAS = os.environ.get("ASR_MODEL_ALIAS", "whisper-small-ct2-int8")
MODEL_REPOSITORY = os.environ.get("ASR_MODEL_REPOSITORY", "Systran/faster-whisper-small")
MODEL_REVISION = os.environ.get("ASR_MODEL_REVISION", "536b0662742c02347bc0e980a01041f333bce120")
CPU_THREADS = int(os.environ.get("ASR_CPU_THREADS", "8"))
MAX_UPLOAD_BYTES = int(os.environ["ASR_MAX_UPLOAD_BYTES"]) if os.environ.get("ASR_MAX_UPLOAD_BYTES") else None
HOST = os.environ.get("ASR_HOST", "0.0.0.0")
PORT = int(os.environ.get("ASR_PORT", "8080"))
LANGUAGE = re.compile(r"^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$")
FORMATS = frozenset({"json", "verbose_json", "text"})
SUFFIXES = frozenset({".wav", ".webm", ".ogg", ".flac", ".mp3", ".m4a", ".mp4"})

if not re.fullmatch(r"[^\s\x00-\x1f]{1,512}", MODEL_ALIAS):
    raise RuntimeError("ASR_MODEL_ALIAS is invalid")
if not 1 <= CPU_THREADS:
    raise RuntimeError("ASR_CPU_THREADS is invalid")
if MAX_UPLOAD_BYTES is not None and MAX_UPLOAD_BYTES <= 0:
    raise RuntimeError("ASR_MAX_UPLOAD_BYTES is invalid")

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
model: WhisperModel | None = None
model_integrity_verified = False
admission = asyncio.Semaphore(1)


def sha256(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(8 * 1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def verify_model_snapshot() -> None:
    manifest_path = MODEL_DIRECTORY / "teamaibox-model-manifest.v1.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("model manifest is unavailable") from error
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("repository") != MODEL_REPOSITORY
        or manifest.get("revision") != MODEL_REVISION
        or not isinstance(manifest.get("files"), list)
        or not manifest["files"]
    ):
        raise RuntimeError("model manifest identity is invalid")
    declared = set()
    for item in manifest["files"]:
        if not isinstance(item, dict) or set(item) != {"path", "sizeBytes", "sha256"}:
            raise RuntimeError("model manifest entry is invalid")
        name = item["path"]
        path = MODEL_DIRECTORY / name
        if (
            not isinstance(name, str)
            or "/" in name
            or name in declared
            or not isinstance(item["sizeBytes"], int)
            or not re.fullmatch(r"[0-9a-f]{64}", item["sha256"])
            or not path.is_file()
            or path.stat().st_size != item["sizeBytes"]
            or sha256(path) != item["sha256"]
        ):
            raise RuntimeError("model snapshot integrity failed")
        declared.add(name)
    if declared != {"config.json", "model.bin", "tokenizer.json", "vocabulary.txt"}:
        raise RuntimeError("model snapshot file set is invalid")


@app.on_event("startup")
async def load_model() -> None:
    global model, model_integrity_verified
    await asyncio.to_thread(verify_model_snapshot)
    model_integrity_verified = True
    model = await asyncio.to_thread(
        WhisperModel,
        str(MODEL_DIRECTORY),
        device="cpu",
        compute_type="int8",
        cpu_threads=CPU_THREADS,
        num_workers=1,
        local_files_only=True,
    )


@app.get("/health/live")
async def live() -> dict[str, Any]:
    return {"status": "live", "model": MODEL_ALIAS}


@app.get("/health/ready")
async def ready() -> JSONResponse:
    available = model is not None and model_integrity_verified
    return JSONResponse(
        status_code=200 if available else 503,
        content={
            "status": "ready" if available else "loading",
            "model": MODEL_ALIAS,
            "device": "cpu",
            "precision": "int8",
            "maximum_concurrent_requests": 1,
        },
        headers={"cache-control": "no-store"},
    )


@app.get("/v1/models")
async def models() -> dict[str, Any]:
    return {"object": "list", "data": [{"id": MODEL_ALIAS, "object": "model", "owned_by": "teamaibox"}]}


def failure(status: int, code: str, message: str, parameter: str | None = None) -> HTTPException:
    return HTTPException(
        status_code=status,
        detail={"error": {"message": message, "type": "invalid_request_error", "param": parameter, "code": code}},
    )


async def store(upload: UploadFile) -> Path:
    suffix = Path(upload.filename or "audio.bin").suffix.lower()
    if suffix not in SUFFIXES:
        raise failure(400, "audio_format_invalid", "The audio container is unsupported.", "file")
    descriptor, name = tempfile.mkstemp(prefix="teamaibox-realtime-asr-", suffix=suffix, dir="/tmp")
    path = Path(name)
    size = 0
    try:
        with os.fdopen(descriptor, "wb") as target:
            while chunk := await upload.read(256 * 1024):
                size += len(chunk)
                if MAX_UPLOAD_BYTES is not None and size > MAX_UPLOAD_BYTES:
                    raise failure(413, "audio_too_large", "The audio chunk exceeds the configured limit.", "file")
                if len(chunk) > min(shutil.disk_usage(path.parent).free, available_memory() // 2):
                    raise failure(503, "audio_storage_busy", "Available worker storage or memory is insufficient. Retry when resources are available.", "file")
                target.write(chunk)
        if size < 44:
            raise failure(400, "audio_empty", "The audio chunk is empty.", "file")
        return path
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    finally:
        await upload.close()


def run_transcription(
    path: Path,
    language: str | None,
    clip: tuple[float, float] | None = None,
) -> dict[str, Any]:
    assert model is not None
    if decoded_audio_budget(probe_media(path).duration_seconds) > available_memory():
        raise failure(503, "audio_memory_busy", "Available worker memory is insufficient to decode this file. Retry when resources are available.", "file")
    clip_start = clip[0] if clip else 0.0
    segments, information = model.transcribe(
        str(path),
        language=language,
        task="transcribe",
        beam_size=1,
        best_of=1,
        temperature=0,
        condition_on_previous_text=False,
        vad_filter=clip is None,
        word_timestamps=False,
        clip_timestamps=list(clip) if clip else "0",
    )
    values = []
    text = []
    result_bytes = 0
    for index, segment in enumerate(segments):
        start = max(0.0, float(segment.start) - clip_start)
        item = {
            "id": index,
            "start": start,
            "end": max(start, float(segment.end) - clip_start),
            "text": str(segment.text),
        }
        result_bytes += len(json.dumps(item).encode('utf8'))
        if result_bytes * 8 > available_memory():
            raise failure(503, "audio_memory_busy", "Available worker memory is insufficient to assemble the result.", "file")
        values.append(item)
        text.append(item["text"])
    return {
        "task": "transcribe",
        "language": str(information.language),
        "duration": float(clip[1] - clip[0]) if clip else float(information.duration),
        "text": "".join(text).strip(),
        "segments": values,
    }


@app.post("/v1/audio/metadata")
async def metadata(file: UploadFile = File(...)) -> JSONResponse:
    path = await store(file)
    try:
        try:
            facts = await asyncio.to_thread(probe_media, path)
        except Exception as error:
            raise failure(400, "audio_invalid", "The media container could not be inspected.", "file") from error
    finally:
        path.unlink(missing_ok=True)
    return JSONResponse(
        {
            "object": "audio.metadata",
            "duration": facts.duration_seconds,
            "stream_types": list(facts.stream_types),
        },
        headers={"cache-control": "no-store"},
    )


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model_name: str = Form(..., alias="model"),
    language: str | None = Form(None),
    response_format: str = Form("json"),
    timestamp_granularities: list[str] = Form(default=[], alias="timestamp_granularities[]"),
    clip_start_seconds: float | None = Form(None, alias="x_teamaibox_clip_start_seconds"),
    clip_end_seconds: float | None = Form(None, alias="x_teamaibox_clip_end_seconds"),
) -> Any:
    if model_name != MODEL_ALIAS:
        raise failure(404, "model_not_found", "The requested model is unavailable.", "model")
    if language is not None and not LANGUAGE.fullmatch(language):
        raise failure(400, "language_invalid", "The language code is invalid.", "language")
    if response_format not in FORMATS:
        raise failure(400, "response_format_invalid", "The response format is unsupported.", "response_format")
    if any(item != "segment" for item in timestamp_granularities):
        raise failure(400, "timestamp_granularity_invalid", "Only segment timestamps are supported.", "timestamp_granularities[]")
    if model is None:
        raise HTTPException(status_code=503, detail={"error": {"message": "The model is loading.", "type": "server_error", "param": None, "code": "model_loading"}})
    path = await store(file)
    try:
        try:
            facts = await asyncio.to_thread(probe_media, path)
            clip = validated_clip(clip_start_seconds, clip_end_seconds, facts.duration_seconds)
        except Exception as error:
            raise failure(400, "clip_invalid", "The requested media clip is invalid.", "x_teamaibox_clip_start_seconds") from error
        async with admission:
            result = await asyncio.to_thread(run_transcription, path, language, clip)
    finally:
        path.unlink(missing_ok=True)
    if response_format == "text":
        return PlainTextResponse(result["text"], headers={"cache-control": "no-store"})
    if response_format == "json":
        return JSONResponse({"text": result["text"]}, headers={"cache-control": "no-store"})
    return JSONResponse(result, headers={"cache-control": "no-store"})


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, access_log=False, server_header=False)
