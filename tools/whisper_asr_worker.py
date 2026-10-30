#!/usr/bin/env python3
"""Content-bounded OpenAI-style Whisper transcription worker."""

from __future__ import annotations

import asyncio
import hashlib
from math import gcd
import os
from pathlib import Path
import tempfile
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse
import numpy as np
from scipy.signal import resample_poly
import soundfile as sf
import uvicorn
import whisper
import torch


MODEL_NAME = os.environ.get("WHISPER_MODEL_NAME", "large-v3")
MODEL_ALIAS = os.environ.get("WHISPER_MODEL_ALIAS", "whisper-large-v3-fp16")
MODEL_DIRECTORY = Path(os.environ.get("WHISPER_MODEL_DIR", "/models"))
MODEL_SHA256 = os.environ.get("WHISPER_MODEL_SHA256", "")
MAX_UPLOAD_BYTES = int(os.environ.get("WHISPER_MAX_UPLOAD_BYTES", str(256 * 1024 * 1024)))
HOST = os.environ.get("WHISPER_HOST", "0.0.0.0")
PORT = int(os.environ.get("WHISPER_PORT", "8080"))
ALLOWED_FORMATS = frozenset({"json", "verbose_json", "text", "srt", "vtt"})
ALLOWED_TIMESTAMPS = frozenset({"segment", "word"})
ALLOWED_SUFFIXES = frozenset({".wav", ".flac", ".ogg", ".mp3", ".aiff", ".aif", ".au", ".caf", ".w64"})
WHISPER_SAMPLE_RATE = 16_000
TRITON_CACHE_DIRECTORY = Path(os.environ.get("TRITON_CACHE_DIR", "/var/cache/triton"))

if MODEL_NAME != "large-v3" or MODEL_ALIAS != "whisper-large-v3-fp16":
    raise RuntimeError("the worker model declaration is not allowlisted")
if len(MODEL_SHA256) != 64 or any(char not in "0123456789abcdef" for char in MODEL_SHA256):
    raise RuntimeError("WHISPER_MODEL_SHA256 is invalid")
if not 1024 <= MAX_UPLOAD_BYTES <= 1024 * 1024 * 1024:
    raise RuntimeError("WHISPER_MAX_UPLOAD_BYTES is invalid")

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
model: Any = None
model_digest_verified = False
timestamp_kernels_ready = False
admission = asyncio.Semaphore(1)


def digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def validate_timestamp_runtime() -> None:
    """Fail closed unless the exact CUDA word-timestamp path can compile and run."""
    if TRITON_CACHE_DIRECTORY != Path("/var/cache/triton"):
        raise RuntimeError("TRITON_CACHE_DIR is not the allowlisted ephemeral cache")
    if not TRITON_CACHE_DIRECTORY.is_dir():
        raise RuntimeError("the Triton timestamp cache is missing")
    try:
        descriptor, probe_name = tempfile.mkstemp(prefix="ready-", dir=TRITON_CACHE_DIRECTORY)
        os.close(descriptor)
        Path(probe_name).unlink()
    except OSError as cache_error:
        raise RuntimeError("the Triton timestamp cache is not writable") from cache_error

    from whisper.timing import dtw_cuda
    from whisper.triton_ops import median_filter_cuda

    median_input = torch.arange(64, dtype=torch.float32, device="cuda").reshape(1, 1, 64)
    median_result = median_filter_cuda(median_input, 7)
    expected_median_shape = (*median_input.shape[:-1], median_input.shape[-1] - 7 + 1)
    if tuple(median_result.shape) != expected_median_shape or not torch.isfinite(median_result).all():
        raise RuntimeError("the Triton median timestamp kernel returned an invalid result")
    alignment_input = torch.zeros((4, 16), dtype=torch.float32, device="cuda")
    alignment = dtw_cuda(alignment_input, BLOCK_SIZE=32)
    if alignment.shape[0] != 2 or alignment.shape[1] == 0:
        raise RuntimeError("the Triton alignment timestamp kernel returned an invalid result")
    torch.cuda.synchronize()


@app.on_event("startup")
async def load_model() -> None:
    global model, model_digest_verified, timestamp_kernels_ready
    checkpoint = MODEL_DIRECTORY / f"{MODEL_NAME}.pt"
    if not checkpoint.is_file() or digest_file(checkpoint) != MODEL_SHA256:
        raise RuntimeError("Whisper checkpoint integrity failed")
    model_digest_verified = True
    model = await asyncio.to_thread(whisper.load_model, MODEL_NAME, device="cuda", download_root=str(MODEL_DIRECTORY))
    await asyncio.to_thread(validate_timestamp_runtime)
    timestamp_kernels_ready = True


@app.get("/health/live")
async def live() -> dict[str, Any]:
    return {"status": "live", "model": MODEL_ALIAS}


@app.get("/health/ready")
async def ready() -> JSONResponse:
    available = model is not None and model_digest_verified and timestamp_kernels_ready
    return JSONResponse(
        status_code=200 if available else 503,
        content={"status": "ready" if available else "loading", "model": MODEL_ALIAS, "device": "cuda", "precision": "fp16"},
        headers={"cache-control": "no-store"},
    )


def error(status: int, code: str, message: str, parameter: str | None = None) -> HTTPException:
    return HTTPException(status_code=status, detail={"error": {"message": message, "type": "invalid_request_error", "param": parameter, "code": code}})


async def store_upload(upload: UploadFile) -> Path:
    suffix = Path(upload.filename or "audio.bin").suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise error(400, "audio_format_invalid", "The audio container is unsupported.", "file")
    descriptor, name = tempfile.mkstemp(prefix="teamaibox-asr-", suffix=suffix, dir="/tmp")
    path = Path(name)
    size = 0
    try:
        with os.fdopen(descriptor, "wb") as target:
            while chunk := await upload.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise error(413, "audio_too_large", "The audio file exceeds the configured limit.", "file")
                target.write(chunk)
        if size == 0:
            raise error(400, "audio_empty", "The audio file is empty.", "file")
        return path
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    finally:
        await upload.close()


def decode_audio(path: Path) -> np.ndarray:
    """Decode allowlisted audio without an ffmpeg subprocess or runtime network."""
    try:
        samples, sample_rate = sf.read(path, dtype="float32", always_2d=True)
    except (OSError, RuntimeError, ValueError) as decode_error:
        raise error(400, "audio_decode_failed", "The audio file could not be decoded.", "file") from decode_error
    if samples.shape[0] == 0 or not 8_000 <= sample_rate <= 384_000:
        raise error(400, "audio_decode_failed", "The decoded audio stream is invalid.", "file")
    mono = np.mean(samples, axis=1, dtype=np.float32)
    if not np.isfinite(mono).all():
        raise error(400, "audio_decode_failed", "The decoded audio contains invalid samples.", "file")
    if sample_rate != WHISPER_SAMPLE_RATE:
        common = gcd(sample_rate, WHISPER_SAMPLE_RATE)
        mono = resample_poly(mono, WHISPER_SAMPLE_RATE // common, sample_rate // common)
    return np.ascontiguousarray(mono, dtype=np.float32)


def run_transcription(path: Path, **options: Any) -> dict[str, Any]:
    return model.transcribe(decode_audio(path), **options)


def timestamp(seconds: float, *, separator: str) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, remaining = divmod(milliseconds, 3_600_000)
    minutes, remaining = divmod(remaining, 60_000)
    seconds_value, millis = divmod(remaining, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds_value:02d}{separator}{millis:03d}"


def subtitle(segments: list[dict[str, Any]], kind: str) -> str:
    values = ["WEBVTT", ""] if kind == "vtt" else []
    separator = "." if kind == "vtt" else ","
    arrow = " --> "
    for index, segment in enumerate(segments, 1):
        if kind == "srt":
            values.append(str(index))
        values.extend([
            timestamp(float(segment["start"]), separator=separator) + arrow + timestamp(float(segment["end"]), separator=separator),
            str(segment.get("text", "")).strip(),
            "",
        ])
    return "\n".join(values)


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model_name: str = Form(..., alias="model"),
    language: str | None = Form(None),
    response_format: str = Form("json"),
    temperature: float = Form(0),
    prompt: str | None = Form(None),
    timestamp_granularities: list[str] = Form(default=[], alias="timestamp_granularities[]"),
) -> Any:
    if model_name != MODEL_ALIAS:
        raise error(404, "model_not_found", "The requested model is unavailable.", "model")
    if response_format not in ALLOWED_FORMATS:
        raise error(400, "response_format_invalid", "The response format is unsupported.", "response_format")
    if not 0 <= temperature <= 1:
        raise error(400, "temperature_invalid", "Temperature must be between 0 and 1.", "temperature")
    if any(item not in ALLOWED_TIMESTAMPS for item in timestamp_granularities):
        raise error(400, "timestamp_granularity_invalid", "A timestamp granularity is unsupported.", "timestamp_granularities[]")
    if model is None:
        raise HTTPException(status_code=503, detail={"error": {"message": "The model is loading.", "type": "server_error", "param": None, "code": "model_loading"}})
    path = await store_upload(file)
    try:
        async with admission:
            result = await asyncio.to_thread(
                run_transcription,
                path,
                language=language,
                task="transcribe",
                fp16=True,
                temperature=temperature,
                initial_prompt=prompt,
                word_timestamps="word" in timestamp_granularities,
                verbose=False,
            )
    finally:
        path.unlink(missing_ok=True)
    text = str(result.get("text", ""))
    segments = list(result.get("segments", []))
    if response_format == "text":
        return PlainTextResponse(text, headers={"cache-control": "no-store"})
    if response_format in {"srt", "vtt"}:
        return PlainTextResponse(subtitle(segments, response_format), headers={"cache-control": "no-store"})
    if response_format == "json":
        return JSONResponse({"text": text}, headers={"cache-control": "no-store"})
    duration = max((float(item.get("end", 0)) for item in segments), default=0)
    return JSONResponse({
        "task": "transcribe",
        "language": result.get("language"),
        "duration": duration,
        "text": text,
        "segments": segments,
    }, headers={"cache-control": "no-store"})


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, access_log=False, server_header=False)
