#!/usr/bin/env python3
"""Bounded OpenAI-compatible MADLAD-400 translation worker."""

from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import threading
import time

import torch
from transformers import T5ForConditionalGeneration, T5Tokenizer


LANGUAGE = {"zh": "zh", "zh-CN": "zh", "zh-TW": "zh", "en": "en", "ja": "ja", "de": "de"}
NUMBER = re.compile(r"\d+(?:[.,:/-]\d+)*")
LATIN = re.compile(r"[A-Za-z][A-Za-z0-9]*(?:[_.+/-][A-Za-z0-9]+)*")
COMMON_INITIAL = frozenset({"a", "an", "and", "are", "as", "at", "but", "by", "for", "from", "he", "her", "his",
    "i", "in", "is", "it", "its", "of", "on", "or", "she", "that", "the", "their", "they", "this", "to", "was",
    "we", "were", "which", "who", "will", "with", "you", "your"})


def protected_tokens(value: str) -> list[str]:
    """Keep numeric/code/proper-name tokens without retaining ordinary source words."""
    values = NUMBER.findall(value)
    for match in LATIN.finditer(value):
        token = match.group(0)
        folded = token.casefold()
        has_marker = any(ch.isdigit() or ch in "_.+/-" for ch in token)
        capitalized_name = token[0].isupper() and not (match.start() == 0 and folded in COMMON_INITIAL)
        if has_marker or capitalized_name or token.isupper():
            values.append(token)
    return list(dict.fromkeys(values))


def restore_tokens(source: str, translated: str) -> str:
    missing = [token for token in protected_tokens(source) if token.casefold() not in translated.casefold()]
    if not missing:
        return translated
    return f"{translated.rstrip()} ({', '.join(missing)})"


def translations_request(value: object) -> tuple[str, list[str]]:
    if not isinstance(value, dict) or not isinstance(value.get("messages"), list):
        raise ValueError("messages are required")
    users = [item.get("content") for item in value["messages"] if isinstance(item, dict) and item.get("role") == "user"]
    if len(users) != 1 or not isinstance(users[0], str):
        raise ValueError("one user message is required")
    body = json.loads(users[0])
    target = LANGUAGE.get(body.get("target_language"))
    segments = body.get("segments")
    if target is None or not isinstance(segments, list) or not (1 <= len(segments) <= 25) or any(
        not isinstance(item, str) or not item or len(item) > 16_384 for item in segments
    ):
        raise ValueError("target language or segments are invalid")
    return target, segments


class Runtime:
    def __init__(self, model_path: str, served_model: str, dtype: str) -> None:
        self.served_model = served_model
        self.dtype = {"bfloat16": torch.bfloat16, "float32": torch.float32}[dtype]
        self.tokenizer = T5Tokenizer.from_pretrained(model_path, local_files_only=True)
        self.model = T5ForConditionalGeneration.from_pretrained(
            model_path, local_files_only=True, torch_dtype=self.dtype, low_cpu_mem_usage=True
        ).eval().to("cuda")
        self.lock = threading.Lock()
        self._startup_self_check()

    def _generate(self, prompts: list[str], max_new_tokens: int) -> list[str]:
        encoded = self.tokenizer(prompts, return_tensors="pt", padding=True, truncation=True, max_length=1024).to("cuda")
        with self.lock, torch.inference_mode():
            output = self.model.generate(**encoded, max_new_tokens=max_new_tokens, num_beams=4, do_sample=False,
                                         early_stopping=True, repetition_penalty=1.05)
        return [item.strip() for item in self.tokenizer.batch_decode(output, skip_special_tokens=True)]

    def _startup_self_check(self) -> None:
        result = self._generate(["<2en> 人工智能正在改变世界。"], 32)
        if len(result) != 1 or not re.search(r"[A-Za-z]{3}", result[0]):
            raise RuntimeError("MADLAD startup translation self-check failed")

    def translate(self, target: str, segments: list[str]) -> list[str]:
        prompts = [f"<2{target}> {item}" for item in segments]
        result = self._generate(prompts, 1024)
        if len(result) != len(segments) or any(not item.strip() for item in result):
            raise RuntimeError("model output is not aligned")
        return [restore_tokens(source, item.strip()) for source, item in zip(segments, result)]


class Handler(BaseHTTPRequestHandler):
    server_version = "TeamAIBoxMADLAD/1"

    def log_message(self, format: str, *args: object) -> None:
        return

    def send_json(self, status: int, body: object) -> None:
        raw = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_json(200, {"status": "ok", "model": self.server.runtime.served_model})
        else:
            self.send_json(404, {"error": {"type": "not_found", "message": "not found"}})

    def do_POST(self) -> None:
        if self.path != "/v1/chat/completions":
            self.send_json(404, {"error": {"type": "not_found", "message": "not found"}}); return
        try:
            size = int(self.headers.get("content-length", "0"))
            if not 0 < size <= 2 * 1024 * 1024:
                raise ValueError("request size is invalid")
            body = json.loads(self.rfile.read(size))
            if body.get("model") != self.server.runtime.served_model or body.get("stream") not in {False, None}:
                raise ValueError("model or streaming mode is invalid")
            target, segments = translations_request(body)
            translated = self.server.runtime.translate(target, segments)
            content = json.dumps({"source_language": "auto", "translations": translated}, ensure_ascii=False, separators=(",", ":"))
            self.send_json(200, {"id": f"chatcmpl-madlad-{time.time_ns()}", "object": "chat.completion",
                "created": int(time.time()), "model": self.server.runtime.served_model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}})
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": {"type": "invalid_request_error", "message": str(error)}})
        except Exception:
            self.send_json(500, {"error": {"type": "worker_error", "message": "translation worker failed"}})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-path", default="/models/model")
    parser.add_argument("--served-model", default="madlad400-3b-mt-bf16")
    parser.add_argument("--dtype", choices=("bfloat16", "float32"), default="bfloat16")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.runtime = Runtime(args.model_path, args.served_model, args.dtype)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
