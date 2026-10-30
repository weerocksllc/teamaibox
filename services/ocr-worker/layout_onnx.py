"""Bounded PP-DocLayoutV3 ONNX inference for the OCR pipeline."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import threading
from typing import Any

import numpy as np
import onnxruntime as ort
from PIL import Image


LABELS = (
    "abstract", "algorithm", "aside_text", "chart", "content", "display_formula",
    "doc_title", "figure_title", "footer", "footer_image", "footnote",
    "formula_number", "header", "header_image", "image", "inline_formula",
    "number", "paragraph_title", "reference", "reference_content", "seal", "table",
    "text", "vertical_text", "vision_footnote",
)
MODEL_INPUT_SIZE = 800
MAX_BOXES = 1_000


@dataclass(frozen=True)
class LayoutBlock:
    label: str
    score: float
    box: tuple[float, float, float, float]
    reading_order: float


def _intersection(a: tuple[float, ...], b: tuple[float, ...]) -> float:
    return max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))


def _area(box: tuple[float, ...]) -> float:
    return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])


def _merge_contained(blocks: list[LayoutBlock], threshold: float = 0.6) -> list[LayoutBlock]:
    suppressed: set[int] = set()
    for left in range(len(blocks)):
        if left in suppressed:
            continue
        for right in range(left + 1, len(blocks)):
            if right in suppressed or blocks[left].label != blocks[right].label:
                continue
            overlap = _intersection(blocks[left].box, blocks[right].box)
            minimum = min(_area(blocks[left].box), _area(blocks[right].box))
            if minimum > 0 and overlap / minimum > threshold:
                suppressed.add(right if _area(blocks[left].box) >= _area(blocks[right].box) else left)
    return [block for index, block in enumerate(blocks) if index not in suppressed]


def _cross_class_nms(blocks: list[LayoutBlock], threshold: float = 0.8) -> list[LayoutBlock]:
    kept: list[LayoutBlock] = []
    suppressed: set[int] = set()
    for left in range(len(blocks)):
        if left in suppressed:
            continue
        kept.append(blocks[left])
        for right in range(left + 1, len(blocks)):
            if right in suppressed:
                continue
            overlap = _intersection(blocks[left].box, blocks[right].box)
            union = _area(blocks[left].box) + _area(blocks[right].box) - overlap
            if union > 0 and overlap / union > threshold:
                suppressed.add(right)
    return kept


def parse_layout_boxes(value: Any, threshold: float, width: int, height: int) -> list[LayoutBlock]:
    if not isinstance(value, np.ndarray) or value.ndim != 2 or value.shape[1] != 7 or value.shape[0] > MAX_BOXES:
        raise ValueError("layout model returned an invalid box tensor")
    blocks: list[LayoutBlock] = []
    for row in value:
        label_id = int(round(float(row[0])))
        score = float(row[1])
        coordinates = tuple(float(item) for item in row[2:6])
        if score < threshold:
            continue
        if label_id < 0 or label_id >= len(LABELS) or not np.isfinite(row).all():
            raise ValueError("layout model returned an invalid region")
        x1, y1, x2, y2 = coordinates
        # The reviewed PP-DocLayoutV3 export can overshoot an image edge by a
        # fraction of a resized pixel.  Clamp only that bounded numerical
        # tolerance; a materially invalid model output must still fail closed.
        x_tolerance = max(2.0, width * 0.005)
        y_tolerance = max(2.0, height * 0.005)
        if (
            x1 < -x_tolerance or y1 < -y_tolerance
            or x2 > width + x_tolerance or y2 > height + y_tolerance
        ):
            raise ValueError("layout model returned out-of-bounds geometry")
        x1, y1 = max(0.0, x1), max(0.0, y1)
        x2, y2 = min(float(width), x2), min(float(height), y2)
        if x2 <= x1 or y2 <= y1:
            raise ValueError("layout model returned out-of-bounds geometry")
        blocks.append(LayoutBlock(
            label=LABELS[label_id], score=round(score, 6),
            box=tuple(round(item, 3) for item in (x1, y1, x2, y2)), reading_order=float(row[6]),
        ))
    blocks.sort(key=lambda block: block.reading_order)
    return _cross_class_nms(_merge_contained(blocks))


class LayoutDetector:
    def __init__(self, model_path: Path, *, threshold: float = 0.3, threads: int = 4):
        if not 0 < threshold <= 1 or not 1 <= threads <= 16:
            raise ValueError("layout detector limits are invalid")
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.enable_cpu_mem_arena = True
        self._session = ort.InferenceSession(str(model_path), sess_options=options, providers=["CPUExecutionProvider"])
        if [item.name for item in self._session.get_inputs()] != ["im_shape", "image", "scale_factor"]:
            raise RuntimeError("layout model input contract drifted")
        outputs = self._session.get_outputs()
        if len(outputs) != 3:
            raise RuntimeError("layout model output contract drifted")
        self._threshold = threshold
        self._lock = threading.Lock()

    def detect(self, image: Image.Image) -> list[LayoutBlock]:
        source = image.convert("RGB")
        width, height = source.size
        resized = source.resize((MODEL_INPUT_SIZE, MODEL_INPUT_SIZE), Image.Resampling.LANCZOS)
        pixels = np.asarray(resized, dtype=np.float32) / np.float32(255.0)
        pixels = np.transpose(pixels, (2, 0, 1))[None]
        feeds = {
            "image": pixels,
            "im_shape": np.array([[MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]], dtype=np.float32),
            "scale_factor": np.array([[MODEL_INPUT_SIZE / height, MODEL_INPUT_SIZE / width]], dtype=np.float32),
        }
        with self._lock:
            outputs = self._session.run(None, feeds)
        return parse_layout_boxes(outputs[0], self._threshold, width, height)
