#!/usr/bin/env python3
"""Generate the deterministic, commercial-safe 400-case OCR quality corpus."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
from pathlib import Path
import re
import subprocess
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "models/ocr-quality-corpus.synthetic.v1.json"
MAGICK = Path("/opt/homebrew/bin/magick")
SLICE_ORDER = ("clean-print", "scan-photo", "complex-layout", "tables-formulas", "multilingual")


class CorpusError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise CorpusError(message)


def digest(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def svg_text(x: int, y: int, value: str, size: int = 24, family: str = "Helvetica Neue",
             weight: int = 400, anchor: str = "start") -> str:
    return (f'<text x="{x}" y="{y}" font-family="{html.escape(family)}" font-size="{size}" '
            f'font-weight="{weight}" text-anchor="{anchor}" fill="#111827">{html.escape(value)}</text>')


def document_svg(width: int, height: int, elements: list[str]) -> bytes:
    body = "".join(elements)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
            f'viewBox="0 0 {width} {height}"><rect width="100%" height="100%" fill="#ffffff"/>'
            f'{body}</svg>').encode()


def render(svg: bytes, output: Path, scan_index: int | None = None) -> bytes:
    if scan_index is None:
        command = [str(MAGICK), "svg:-", "-strip", "-define", "png:color-type=2", "png:-"]
    else:
        angle = (-1.8, -1.1, -0.5, 0.6, 1.2, 1.7)[scan_index % 6]
        command = [str(MAGICK), "svg:-", "-background", "#e8e4dc", "-alpha", "remove",
                   "-seed", str(20260829 + scan_index), "-rotate", str(angle),
                   "-attenuate", str(0.012 + (scan_index % 4) * 0.004), "+noise", "Gaussian",
                   "-blur", f"0x{0.25 + (scan_index % 3) * 0.15:.2f}",
                   "-quality", str(70 + scan_index % 9), "jpg:-"]
    completed = subprocess.run(command, input=svg, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               timeout=60, check=False)
    require(completed.returncode == 0 and len(completed.stdout) > 1000,
            "ImageMagick corpus rendering failed: " + completed.stderr.decode(errors="replace")[-800:])
    output.write_bytes(completed.stdout)
    return completed.stdout


def text_case(slice_key: str, index: int) -> tuple[bytes, dict[str, Any]]:
    if slice_key == "multilingual":
        title = f"团队算力验证记录 {index + 1:03d}"
        lines = [
            f"任务编号 BOX-{index + 1:03d} 已完成，输出校验一致。",
            f"统一内存峰值为 {42 + index % 31} GB，核心服务保持健康。",
            f"队列处理了 {1200 + index * 7} 个令牌，没有丢失请求。",
            "Team AI Box supports secure local inference and collaboration.",
            f"Validation batch {index + 1:03d} finished with deterministic results.",
        ]
        family = "Hiragino Sans GB"
    elif slice_key == "scan-photo":
        title = f"FIELD SERVICE NOTE {index + 1:03d}"
        lines = [
            f"Device SPARK-{index + 1:03d} completed inspection at station {3 + index % 17}.",
            f"Measured temperature was {41 + index % 24} degrees Celsius under bounded load.",
            f"Network transfer batch {8000 + index * 13} passed checksum verification.",
            "The operator confirmed that every protected object remained accessible.",
            f"Maintenance window reference MW-{2026082900 + index} is now closed.",
        ]
        family = "Helvetica Neue"
    else:
        title = f"SYSTEM VALIDATION REPORT {index + 1:03d}"
        lines = [
            f"Node SPARK-{index + 1:03d} completed queue batch {1000 + index * 11}.",
            f"Memory pressure remained below {55 + index % 21} percent during the interval.",
            f"The scheduler preserved {12 + index % 9} gigabytes for core services.",
            "All model artifacts matched their recorded content digests.",
            f"Audit sequence {90000 + index * 19} finished without duplicate jobs.",
        ]
        family = "Helvetica Neue"
    elements = [svg_text(72, 100, title, 34, family, 700)]
    for line_number, line in enumerate(lines):
        elements.append(svg_text(72, 190 + line_number * 82, line, 25, family))
    elements += [
        '<line x1="72" y1="125" x2="952" y2="125" stroke="#475569" stroke-width="2"/>',
        svg_text(72, 690, f"PAGE {index + 1:03d} / VERIFIED", 18, family, 500),
    ]
    return document_svg(1024, 768, elements), {
        "referenceText": "\n".join([title, *lines]),
        "blocks": [], "tableHtml": None, "expectedOrder": [],
    }


def complex_case(index: int) -> tuple[bytes, dict[str, Any]]:
    title = f"DISTRIBUTED COMPUTE REVIEW {index + 1:03d}"
    blocks = []
    elements = [svg_text(64, 82, title, 35, "Helvetica Neue", 700),
                '<line x1="64" y1="108" x2="1216" y2="108" stroke="#334155" stroke-width="2"/>']
    expected = []
    order = 0
    for row in range(3):
        for column, x in enumerate((64, 674)):
            y = 150 + row * 250
            heading = f"SECTION {column * 3 + row + 1}: NODE {index + 1:03d}-{column + 1}{row + 1}"
            lines = [
                f"Lease generation {100 + index + row} remained fenced and durable.",
                f"Worker group processed {320 + index * 3 + row * 7} bounded requests.",
                "Control services stayed available during model transitions.",
                f"Observed recovery window was {18 + (index + row) % 17} seconds.",
            ]
            elements.append(f'<rect x="{x}" y="{y}" width="542" height="205" rx="8" '
                            'fill="#f8fafc" stroke="#cbd5e1" stroke-width="1"/>')
            elements.append(svg_text(x + 18, y + 38, heading, 21, "Helvetica Neue", 700))
            for number, line in enumerate(lines):
                elements.append(svg_text(x + 18, y + 76 + number * 29, line, 17, "Helvetica Neue"))
            text = "\n".join([heading, *lines])
            blocks.append(text)
            expected.append({"label": "text", "bbox": [x + 12, y + 13, x + 305, y + 49], "order": order})
            order += 1
            widths = (430, 405, 480, 375)
            for line_number, line_width in enumerate(widths):
                line_top = y + 55 + line_number * 29
                expected.append({"label": "text", "bbox": [x + 12, line_top, x + line_width,
                                                              line_top + 32], "order": order})
                order += 1
    elements.append(svg_text(64, 930, f"CONFIDENTIALITY-SAFE SYNTHETIC FIXTURE {index + 1:03d}",
                             16, "Helvetica Neue", 500))
    return document_svg(1280, 960, elements), {
        "referenceText": "\n".join([title, *blocks]), "blocks": expected,
        "tableHtml": None, "expectedOrder": [item["order"] for item in expected],
    }


def table_case(index: int) -> tuple[bytes, dict[str, Any]]:
    width, height = 1024, 768
    title = f"RESOURCE ALLOCATION MATRIX {index + 1:03d}"
    formula = f"R_{{{index + 1}}} = CPU + Memory + Queue"
    x0, y0, cell_w, cell_h = 92, 220, 210, 82
    rows = [
        ["Node", "CPU", "Memory", "Jobs"],
        [f"Spark-{index % 7 + 1}", str(4 + index % 9), f"{32 + index % 5 * 8} GB", str(10 + index % 13)],
        [f"Worker-{index % 11 + 1}", str(2 + index % 7), f"{16 + index % 4 * 8} GB", str(20 + index % 17)],
        ["Total", str(8 + index % 16), f"{64 + index % 4 * 16} GB", str(40 + index % 21)],
    ]
    elements = [svg_text(72, 88, title, 34, "Helvetica Neue", 700),
                svg_text(72, 158, formula, 27, "Times New Roman", 400)]
    for row, values in enumerate(rows):
        for column, value in enumerate(values):
            x, y = x0 + column * cell_w, y0 + row * cell_h
            fill = "#e2e8f0" if row == 0 else "#ffffff"
            elements.append(f'<rect x="{x}" y="{y}" width="{cell_w}" height="{cell_h}" '
                            f'fill="{fill}" stroke="#0f172a" stroke-width="2"/>')
            elements.append(svg_text(x + cell_w // 2, y + 51, value, 22, "Helvetica Neue",
                                     700 if row == 0 else 400, "middle"))
    table_html = "<table>" + "".join(
        "<tr>" + "".join(f"<td>{html.escape(value)}</td>" for value in row) + "</tr>" for row in rows
    ) + "</table>"
    return document_svg(width, height, elements), {
        "referenceText": "\n".join([title, formula, *[" ".join(row) for row in rows]]),
        "blocks": [
            {"label": "doc_title", "bbox": [66, 48, 958, 102], "order": 0},
            {"label": "display_formula", "bbox": [66, 120, 760, 176], "order": 1},
            {"label": "table", "bbox": [x0, y0, x0 + 4 * cell_w, y0 + 4 * cell_h], "order": 2},
        ],
        "tableHtml": table_html, "expectedOrder": [0, 1, 2],
    }


def verify_environment(spec: dict[str, Any]) -> dict[str, Any]:
    require(MAGICK.is_file(), "required ImageMagick renderer is absent")
    require(digest(MAGICK.read_bytes()) == spec["renderer"]["binarySha256"], "ImageMagick binary digest drifted")
    version = subprocess.run([str(MAGICK), "-version"], text=True, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, timeout=30, check=True).stdout.splitlines()[0]
    require(spec["renderer"]["requiredVersionPrefix"] in version, "ImageMagick version drifted")
    fonts = []
    for item in spec["fonts"]:
        path = Path(item["path"])
        require(path.is_file() and digest(path.read_bytes()) == item["sha256"],
                f"font identity drifted: {item['family']}")
        fonts.append({"family": item["family"], "sha256": item["sha256"]})
    return {"version": version, "binarySha256": spec["renderer"]["binarySha256"], "fonts": fonts}


def generate(output: Path, per_slice: int) -> dict[str, Any]:
    require(1 <= per_slice <= 80, "per-slice case count must be in [1, 80]")
    require(not output.exists() or not any(output.iterdir()), "corpus output directory is not empty")
    output.mkdir(parents=True, exist_ok=True)
    spec = json.loads(SPEC.read_text(encoding="utf-8"))
    renderer = verify_environment(spec)
    records = []
    for slice_key in SLICE_ORDER:
        directory = output / slice_key
        directory.mkdir(mode=0o750)
        for index in range(per_slice):
            if slice_key == "complex-layout":
                svg, annotation = complex_case(index)
            elif slice_key == "tables-formulas":
                svg, annotation = table_case(index)
            else:
                svg, annotation = text_case(slice_key, index)
            extension = ".jpg" if slice_key == "scan-photo" else ".png"
            case_id = f"{slice_key}-{index + 1:03d}"
            image_path = directory / (case_id + extension)
            raw = render(svg, image_path, index if slice_key == "scan-photo" else None)
            annotation_path = directory / (case_id + ".json")
            annotation_value = {"caseId": case_id, "slice": slice_key, **annotation}
            annotation_raw = json.dumps(annotation_value, ensure_ascii=False, sort_keys=True,
                                        separators=(",", ":")).encode() + b"\n"
            annotation_path.write_bytes(annotation_raw)
            records.append({
                "caseId": case_id, "slice": slice_key,
                "image": image_path.relative_to(output).as_posix(), "inputDigest": digest(raw),
                "inputBytes": len(raw), "annotation": annotation_path.relative_to(output).as_posix(),
                "annotationDigest": digest(annotation_raw),
            })
    manifest = {
        "schemaVersion": 1, "corpusKey": spec["corpusKey"], "corpusVersion": spec["version"],
        "license": spec["license"], "caseCount": len(records),
        "sliceCounts": {key: per_slice for key in SLICE_ORDER},
        "generationSeed": spec["generationSeed"], "specDigest": digest(SPEC.read_bytes()),
        "generatorDigest": digest(Path(__file__).read_bytes()), "renderer": renderer,
        "contentPolicy": spec["contentPolicy"], "limitations": spec["limitations"], "cases": records,
    }
    manifest["corpusDigest"] = digest(canonical(manifest))
    (output / "manifest.json").write_bytes(json.dumps(manifest, ensure_ascii=False, indent=2,
                                                      sort_keys=True).encode() + b"\n")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--per-slice", type=int, default=80)
    args = parser.parse_args()
    value = generate(args.output.resolve(), args.per_slice)
    print(json.dumps({"corpusDigest": value["corpusDigest"], "caseCount": value["caseCount"],
                      "output": str(args.output.resolve())}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (CorpusError, OSError, ValueError, json.JSONDecodeError, subprocess.SubprocessError) as error:
        print(f"OCR quality corpus generation failed: {error}")
        raise SystemExit(1)
