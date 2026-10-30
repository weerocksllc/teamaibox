#!/usr/bin/env python3
"""Generate the immutable 240-case synthetic Drawing quality manifest."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "models/drawing-quality-corpus.synthetic.v1.json"


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def digest(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def generate() -> dict[str, Any]:
    spec = json.loads(SPEC.read_text(encoding="utf-8"))
    negative = spec["negativePrompt"]
    records: list[dict[str, Any]] = []

    subjects = ["green ceramic teapot", "blue glass vase", "small red robot", "yellow bicycle",
                "silver desk lamp", "orange hiking backpack", "wooden sailboat", "white espresso cup",
                "purple book", "black studio camera"]
    layouts = [
        "centered between two matching pears with balanced negative space",
        "on the left third with a smaller round object on the right third",
        "in the foreground with two progressively smaller objects behind it",
        "seen from above inside a precise triangle of three smooth stones",
        "framed by an arch with a clear foreground, middle ground and background",
        "centered symmetrically on a clean desk with one object on each side",
    ]
    for index in range(60):
        subject, layout = subjects[index % len(subjects)], layouts[index // len(subjects)]
        prompt = f"Professional product photograph of a {subject}, {layout}, soft studio light, clean background, no text"
        records.append({"slice": "composition", "prompt": prompt,
                        "positiveControl": "a coherent professional image with the requested objects and spatial composition",
                        "negativeControl": "a chaotic image with missing objects and incorrect spatial composition"})

    styles = ["watercolor illustration", "Japanese woodblock print", "Art Deco poster", "clay stop-motion scene",
              "low-poly 3D render", "ink line drawing", "paper-cut collage", "cinematic product photograph",
              "isometric vector illustration", "soft pastel painting"]
    style_subjects = ["a quiet mountain library", "a solar-powered coastal village", "a friendly delivery robot",
                      "a greenhouse at sunrise", "a compact team computing appliance", "a train crossing a forest bridge"]
    for index in range(60):
        style, subject = styles[index % len(styles)], style_subjects[index // len(styles)]
        prompt = f"{style} of {subject}, clearly recognizable style, deliberate color palette, polished composition, no text"
        records.append({"slice": "style", "prompt": prompt,
                        "positiveControl": f"a polished {style} with a clear subject and deliberate visual style",
                        "negativeControl": "an unfinished generic image with no recognizable style or subject"})

    sign_types = ["minimal white poster", "green enamel sign", "black conference badge", "blue storefront placard",
                  "cream paper card", "silver desk display", "orange transit sign", "dark presentation slide"]
    settings = ["front-facing under even light", "centered on a plain wall", "isolated on a clean desk",
                "shown straight-on without perspective distortion", "large in frame with strong contrast"]
    for index in range(40):
        sign, setting = sign_types[index % len(sign_types)], settings[index // len(sign_types)]
        prompt = f'A {sign}, {setting}, showing only the two large uppercase letters "AI", crisp readable typography, no other words'
        records.append({"slice": "text-rendering", "prompt": prompt, "targetText": "AI",
                        "positiveControl": "a clean sign with two large readable uppercase letters AI",
                        "negativeControl": "a blank sign or garbled unreadable pseudo-text"})

    people_scenes = ["an adult holding a ceramic mug", "an adult opening a notebook", "an adult presenting a small box",
                     "an adult typing on a compact keyboard", "an adult arranging flowers", "an adult holding a camera",
                     "an adult tying a ribbon", "an adult carrying a reusable bottle"]
    people_styles = ["natural editorial photograph", "clean studio photograph", "realistic lifestyle photograph",
                     "soft daylight portrait", "professional documentary photograph"]
    for index in range(40):
        scene, style = people_scenes[index % len(people_scenes)], people_styles[index // len(people_scenes)]
        prompt = f"{style} of {scene}, both hands fully visible, natural anatomy, five fingers per hand, no text"
        records.append({"slice": "people-hands", "prompt": prompt,
                        "positiveControl": "a realistic person with natural anatomically correct hands and fingers",
                        "negativeControl": "a person with severely deformed hands, fused fingers or extra limbs"})

    zh_subjects = [("绿色茶壶", "a green teapot"), ("蓝色花瓶", "a blue vase"),
                   ("小型机器人", "a small robot"), ("山间图书馆", "a mountain library"),
                   ("海边风力发电站", "a coastal wind farm"), ("温室里的向日葵", "sunflowers in a greenhouse"),
                   ("森林中的木屋", "a cabin in a forest"), ("整洁的团队工作台", "a tidy team workspace")]
    zh_layouts = ["居中构图，背景简洁", "位于画面左侧三分之一处，右侧有一盏小灯",
                  "前景清晰、远景柔和", "对称构图，柔和自然光", "俯视构图，物体排列成三角形"]
    zh_layouts_en = ["centered with a clean background", "on the left third with a small lamp on the right",
                     "a clear foreground and soft distant background", "symmetrical with soft natural light",
                     "seen from above with objects in a triangular arrangement"]
    for index in range(40):
        (subject, subject_en), layout = zh_subjects[index % len(zh_subjects)], zh_layouts[index // len(zh_subjects)]
        prompt = f"一幅专业精致的{subject}图像，{layout}，颜色协调，细节清楚，不要文字和水印"
        evaluation_prompt = f"A polished image of {subject_en}, {zh_layouts_en[index // len(zh_subjects)]}, harmonious colors, clear details, no text"
        records.append({"slice": "zh-prompts", "prompt": prompt, "evaluationPrompt": evaluation_prompt,
                        "positiveControl": f"a clear image of {subject_en} with the requested composition",
                        "negativeControl": "an unrelated low quality image with a missing subject and chaotic composition"})

    expected = spec["sliceCounts"]
    counts = {key: sum(item["slice"] == key for item in records) for key in expected}
    if len(records) != 240 or counts != expected:
        raise ValueError("Drawing quality corpus slice counts drifted")
    for index, record in enumerate(records):
        record.update({"caseId": f"drawing-quality-{index + 1:03d}",
                       "seed": [17, 42, 314159][index % 3], "steps": 28,
                       "guidanceScale": 6.5, "size": "512x512", "negativePrompt": negative,
                       "slices": ["overall", record["slice"]]})
    manifest = {
        "schemaVersion": 1, "corpusKey": spec["corpusKey"], "corpusVersion": spec["version"],
        "license": spec["license"], "caseCount": len(records), "sliceCounts": counts,
        "generationSeed": spec["generationSeed"], "specDigest": digest(SPEC.read_bytes()),
        "generatorDigest": digest(Path(__file__).read_bytes()), "contentPolicy": spec["contentPolicy"],
        "limitations": spec["limitations"], "cases": records,
    }
    manifest["corpusDigest"] = digest(canonical(manifest))
    return manifest


if __name__ == "__main__":
    print(json.dumps(generate(), ensure_ascii=False, indent=2, sort_keys=True))
