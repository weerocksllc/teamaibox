#!/usr/bin/env python3
"""Media probing and clip validation shared by the batch ASR HTTP surface."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
import math


AV_TIME_BASE = 1_000_000


@dataclass(frozen=True)
class MediaFacts:
    duration_seconds: float
    stream_types: tuple[str, ...]


def probe_media(path: Path, opener: Callable[[str], Any] | None = None) -> MediaFacts:
    if opener is None:
        import av

        opener = av.open
    with opener(str(path)) as container:
        stream_types = tuple(sorted({
            str(stream.type)
            for stream in container.streams
            if str(getattr(stream, "type", "")) in {"audio", "video"}
        }))
        if not stream_types:
            raise ValueError("media has no audio or video stream")
        durations = []
        container_duration = getattr(container, "duration", None)
        if container_duration is not None:
            durations.append(float(container_duration) / AV_TIME_BASE)
        for stream in container.streams:
            duration = getattr(stream, "duration", None)
            time_base = getattr(stream, "time_base", None)
            if duration is not None and time_base is not None:
                durations.append(float(duration * time_base))
        duration_seconds = max((value for value in durations if math.isfinite(value) and value > 0), default=0.0)
        if not duration_seconds > 0:
            raise ValueError("media duration is unavailable")
        return MediaFacts(duration_seconds=duration_seconds, stream_types=stream_types)


def validated_clip(
    start_seconds: float | None,
    end_seconds: float | None,
    duration_seconds: float,
) -> tuple[float, float] | None:
    if start_seconds is None and end_seconds is None:
        return None
    if start_seconds is None or end_seconds is None:
        raise ValueError("clip start and end are required together")
    start = float(start_seconds)
    end = float(end_seconds)
    if not all(math.isfinite(v) for v in (start, end, duration_seconds)) or start < 0 or end <= start or end > duration_seconds + 0.050:
        raise ValueError("clip range is outside the media duration")
    return start, min(end, duration_seconds)


def decoded_audio_budget(duration_seconds: float) -> int:
    """Account for 16 kHz float32 PCM, decode copies and mel features.

    faster-whisper loads the entire input before applying clip timestamps, so
    admission must use the full duration, even when the user selects a clip.
    This is a memory estimate, not a product duration ceiling.
    """
    if not math.isfinite(duration_seconds) or duration_seconds <= 0:
        raise ValueError('invalid audio duration')
    return math.ceil(duration_seconds * 16000 * 4 * 8)
