#!/usr/bin/env python3
"""Content-safe OpenAI protocol probe for the Qwen3.8-27B NVFP4 runtime."""

from __future__ import annotations

import argparse
import hashlib
import json
import time
import urllib.request
from typing import Any, Mapping


MAX_BYTES = 4 * 1024 * 1024


class ProbeError(RuntimeError):
    pass


def digest(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def request(path: str, *, method: str = "GET", body: Mapping[str, Any] | None = None,
            timeout: int = 300) -> tuple[int, bytes]:
    payload = None if body is None else json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
    req = urllib.request.Request("http://127.0.0.1:8000" + path, data=payload, method=method,
                                 headers={"Accept": "application/json, text/event-stream",
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        raw = response.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ProbeError("response exceeded evidence bound")
        return response.status, raw


def completed(model: str, messages: list[dict[str, str]], *, max_tokens: int = 64,
              tools: list[dict[str, Any]] | None = None, tool_choice: Any = None) -> dict[str, Any]:
    body: dict[str, Any] = {"model": model, "messages": messages, "max_tokens": max_tokens,
                            "temperature": 0, "seed": 1337, "stream": False,
                            "chat_template_kwargs": {"enable_thinking": False}}
    if tools is not None:
        body["tools"] = tools
        body["tool_choice"] = tool_choice
    started = time.monotonic()
    status, raw = request("/v1/chat/completions", method="POST", body=body)
    value = json.loads(raw)
    message = value["choices"][0]["message"]
    content = str(message.get("content") or "").strip()
    calls = message.get("tool_calls") or []
    arguments_valid_shanghai = False
    if len(calls) == 1:
        try:
            arguments = json.loads(str(calls[0].get("function", {}).get("arguments", "{}")))
            arguments_valid_shanghai = isinstance(arguments.get("city"), str) and "shanghai" in arguments["city"].lower()
        except (json.JSONDecodeError, AttributeError):
            pass
    return {"httpStatus": status, "durationMs": round((time.monotonic() - started) * 1000, 3),
            "contentBytes": len(content.encode()), "contentDigest": digest(content.encode()),
            "contentEquals714": content == "714",
            "contentContainsCjk": any("\u4e00" <= char <= "\u9fff" for char in content),
            "toolCallCount": len(calls),
            "toolCallNames": [str(x.get("function", {}).get("name", "")) for x in calls],
            "toolArgumentsDigests": [digest(str(x.get("function", {}).get("arguments", "")).encode()) for x in calls],
            "toolArgumentsValidShanghai": arguments_valid_shanghai,
            "usage": {k: int(v) for k, v in (value.get("usage") or {}).items() if isinstance(v, int)}}


def streaming(model: str) -> dict[str, Any]:
    body = {"model": model, "messages": [{"role": "user", "content": "Reply with exactly: STREAM_OK"}],
            "max_tokens": 32, "temperature": 0, "seed": 1337, "stream": True,
            "stream_options": {"include_usage": True},
            "chat_template_kwargs": {"enable_thinking": False}}
    payload = json.dumps(body, separators=(",", ":")).encode()
    req = urllib.request.Request("http://127.0.0.1:8000/v1/chat/completions", data=payload, method="POST",
                                 headers={"Accept": "text/event-stream", "Content-Type": "application/json"})
    started = time.monotonic()
    parts: list[str] = []
    events = 0
    done = False
    total = 0
    with urllib.request.urlopen(req, timeout=300) as response:
        status = response.status
        for raw in response:
            total += len(raw)
            if total > MAX_BYTES:
                raise ProbeError("stream exceeded evidence bound")
            line = raw.strip()
            if not line.startswith(b"data:"):
                continue
            data = line[5:].strip()
            if data == b"[DONE]":
                done = True
                break
            event = json.loads(data)
            events += 1
            for choice in event.get("choices", []):
                parts.append(str(choice.get("delta", {}).get("content") or ""))
    content = "".join(parts).strip()
    return {"httpStatus": status, "durationMs": round((time.monotonic() - started) * 1000, 3),
            "eventCount": events, "done": done, "contentBytes": len(content.encode()),
            "contentDigest": digest(content.encode())}


def cancel(model: str) -> dict[str, Any]:
    body = {"model": model, "messages": [{"role": "user", "content": "Count slowly from 1 to 500."}],
            "max_tokens": 1024, "temperature": 0, "stream": True,
            "chat_template_kwargs": {"enable_thinking": False}}
    req = urllib.request.Request("http://127.0.0.1:8000/v1/chat/completions",
        data=json.dumps(body, separators=(",", ":")).encode(), method="POST",
        headers={"Accept": "text/event-stream", "Content-Type": "application/json"})
    started = time.monotonic()
    received = 0
    response = urllib.request.urlopen(req, timeout=300)
    try:
        for raw in response:
            if raw.strip().startswith(b"data:"):
                received += 1
            if received >= 2:
                break
    finally:
        response.close()
    time.sleep(1)
    health, _ = request("/health", timeout=30)
    return {"connectionClosedEarly": True, "eventsBeforeClose": received,
            "runtimeHealthyAfterClose": health == 200,
            "durationMs": round((time.monotonic() - started) * 1000, 3)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    status, raw = request("/v1/models", timeout=30)
    models = json.loads(raw)
    ids = [str(x.get("id")) for x in models.get("data", [])]
    if status != 200 or ids != [args.model]:
        raise ProbeError("served model identity mismatch")
    arithmetic = completed(args.model, [
        {"role": "system", "content": "Follow output format exactly."},
        {"role": "user", "content": "Return exactly these three ASCII digits and nothing else: 714"}], max_tokens=32)
    chinese = completed(args.model, [{"role": "user", "content": "请用一句简短中文确认本地模型可用。"}], max_tokens=64)
    tools = [{"type": "function", "function": {"name": "lookup_time", "description": "Look up local time",
              "parameters": {"type": "object", "properties": {"city": {"type": "string"}},
                             "required": ["city"], "additionalProperties": False}}}]
    tool = completed(args.model, [{"role": "user", "content": "What time is it in Shanghai?"}], max_tokens=64,
                     tools=tools, tool_choice={"type": "function", "function": {"name": "lookup_time"}})
    long_context = completed(args.model, [{"role": "user", "content": ("alpha beta gamma delta " * 3072)
        + "\nReturn only the final word before this instruction."}], max_tokens=16)
    stream = streaming(args.model)
    cancellation = cancel(args.model)
    checks = {
        "arithmetic": arithmetic["httpStatus"] == 200 and arithmetic["contentEquals714"],
        "chinese": chinese["httpStatus"] == 200 and chinese["contentContainsCjk"],
        "tool_call": (tool["toolCallCount"] == 1 and tool["toolCallNames"] == ["lookup_time"]
                      and tool["toolArgumentsValidShanghai"]),
        "long_context": (long_context["httpStatus"] == 200
                         and long_context["usage"].get("prompt_tokens", 0) >= 6000),
        "streaming": stream["httpStatus"] == 200 and stream["done"] and stream["contentBytes"] > 0,
        "cancellation": cancellation["eventsBeforeClose"] >= 1 and cancellation["runtimeHealthyAfterClose"],
    }
    failed_checks = sorted(name for name, passed in checks.items() if not passed)
    result = {"schemaVersion": 1, "model": args.model, "modelsEndpoint": {"httpStatus": status, "ids": ids},
              "arithmetic": arithmetic, "chinese": chinese, "toolCalling": tool,
              "longContext": long_context, "streaming": stream, "cancellation": cancellation,
              "checks": checks, "failedChecks": failed_checks,
              "contentRetained": False, "passed": not failed_checks}
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    if failed_checks:
        raise ProbeError("runtime protocol matrix failed: " + ",".join(failed_checks))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
