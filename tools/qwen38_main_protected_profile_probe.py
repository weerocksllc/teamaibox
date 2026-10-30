#!/usr/bin/env python3
"""Content-free Answer/Agent protocol probe for the protected Qwen3.8 runtime."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import time
import urllib.parse
import urllib.request
from typing import Any, Mapping


MAX_RESPONSE_BYTES = 4 * 1024 * 1024


class ProbeError(RuntimeError):
    pass


def require(value: bool, message: str) -> None:
    if not value:
        raise ProbeError(message)


def digest(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def request(base_url: str, path: str, *, method: str = "GET",
            body: Mapping[str, Any] | None = None, timeout: int = 300) -> tuple[int, bytes]:
    payload = None if body is None else json.dumps(
        body, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    target = urllib.parse.urljoin(base_url.rstrip("/") + "/", path.lstrip("/"))
    value = urllib.request.Request(
        target, data=payload, method=method,
        headers={"Accept": "application/json, text/event-stream",
                 "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(value, timeout=timeout) as response:
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        require(len(raw) <= MAX_RESPONSE_BYTES, "response exceeded probe evidence bound")
        return response.status, raw


def completion(base_url: str, body: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    started = time.monotonic()
    status, raw = request(base_url, "/v1/chat/completions", method="POST", body=body)
    value = json.loads(raw)
    message = value["choices"][0]["message"]
    content = str(message.get("content") or "").strip()
    calls = message.get("tool_calls") or []
    summary = {
        "httpStatus": status,
        "durationMs": round((time.monotonic() - started) * 1000, 3),
        "contentBytes": len(content.encode("utf-8")),
        "contentDigest": digest(content.encode("utf-8")),
        "contentEquals714": content == "714",
        "contentEqualsAgentOk": content == "AGENT_OK",
        "contentContainsCjk": any("\u4e00" <= character <= "\u9fff" for character in content),
        "toolCallCount": len(calls),
        "toolCallNames": [str(item.get("function", {}).get("name", "")) for item in calls],
        "toolArgumentDigests": [
            digest(str(item.get("function", {}).get("arguments", "")).encode("utf-8"))
            for item in calls
        ],
        "usage": {
            key: int(number) for key, number in (value.get("usage") or {}).items()
            if isinstance(number, int) and not isinstance(number, bool)
        },
    }
    return message, summary


def body(model: str, messages: list[dict[str, Any]], *, max_tokens: int = 64,
         tools: list[dict[str, Any]] | None = None, tool_choice: Any = None) -> dict[str, Any]:
    value: dict[str, Any] = {
        "model": model, "messages": messages, "max_tokens": max_tokens,
        "temperature": 0, "seed": 1337, "stream": False,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    if tools is not None:
        value["tools"] = tools
        value["tool_choice"] = tool_choice
    return value


def answer_probe(base_url: str, model: str) -> dict[str, Any]:
    _, arithmetic = completion(base_url, body(model, [
        {"role": "system", "content": "Follow the requested output format exactly."},
        {"role": "user", "content": "Return exactly these three ASCII digits and nothing else: 714"},
    ], max_tokens=32))
    _, chinese = completion(base_url, body(model, [
        {"role": "user", "content": "请用一句简短中文确认本地办公助手可用。"},
    ], max_tokens=64))
    return {"arithmetic": arithmetic, "chinese": chinese}


def agent_probe(base_url: str, model: str) -> dict[str, Any]:
    tools = [{
        "type": "function",
        "function": {
            "name": "lookup_time", "description": "Look up local time",
            "parameters": {
                "type": "object", "properties": {"city": {"type": "string"}},
                "required": ["city"], "additionalProperties": False,
            },
        },
    }]
    initial_messages: list[dict[str, Any]] = [
        {"role": "system", "content": "Use the required tool, then follow the final format exactly."},
        {"role": "user", "content": "What time is it in Shanghai?"},
    ]
    assistant, tool_summary = completion(
        base_url,
        body(model, initial_messages, tools=tools,
             tool_choice={"type": "function", "function": {"name": "lookup_time"}}),
    )
    calls = assistant.get("tool_calls") or []
    require(len(calls) == 1, "agent probe did not request exactly one tool")
    call = calls[0]
    arguments = json.loads(str(call.get("function", {}).get("arguments", "{}")))
    arguments_valid = (
        isinstance(arguments, Mapping)
        and isinstance(arguments.get("city"), str)
        and "shanghai" in arguments["city"].lower()
    )
    follow_up_messages = [
        *initial_messages,
        assistant,
        {"role": "tool", "tool_call_id": str(call.get("id", "")),
         "content": "The local time lookup succeeded. Reply exactly: AGENT_OK"},
    ]
    _, final_summary = completion(base_url, body(
        model, follow_up_messages, max_tokens=32, tools=tools, tool_choice="none"
    ))
    return {
        "toolRequest": {**tool_summary, "argumentsValidShanghai": arguments_valid},
        "toolContinuation": final_summary,
        "completedToolLoop": (
            tool_summary["toolCallNames"] == ["lookup_time"]
            and arguments_valid
            and final_summary["contentEqualsAgentOk"]
        ),
    }


def context_32k_probe(base_url: str, model: str) -> dict[str, Any]:
    # The same Qwen tokenizer/runtime previously measured this deterministic
    # corpus at roughly 28.7k prompt tokens: close enough to exercise the 32k
    # window while retaining room for the chat template and bounded output.
    _, summary = completion(base_url, body(model, [
        {"role": "user", "content": ("alpha beta gamma delta " * 7168)
         + "\nReturn only the final word before this instruction."},
    ], max_tokens=16))
    prompt_tokens = summary["usage"].get("prompt_tokens", 0)
    return {
        **summary, "configuredContextTokens": 32768,
        "targetMinimumPromptTokens": 28000,
        "nearWindowAccepted": 28000 <= prompt_tokens < 32768,
    }


def stream_probe(base_url: str, model: str) -> dict[str, Any]:
    stream_body = body(model, [
        {"role": "user", "content": "Reply with exactly: STREAM_OK"},
    ], max_tokens=32)
    stream_body["stream"] = True
    stream_body["stream_options"] = {"include_usage": True}
    payload = json.dumps(stream_body, separators=(",", ":")).encode("utf-8")
    target = urllib.parse.urljoin(base_url.rstrip("/") + "/", "v1/chat/completions")
    req = urllib.request.Request(
        target, data=payload, method="POST",
        headers={"Accept": "text/event-stream", "Content-Type": "application/json"},
    )
    started = time.monotonic()
    output: list[str] = []
    event_count = 0
    total = 0
    done = False
    with urllib.request.urlopen(req, timeout=300) as response:
        status = response.status
        for raw in response:
            total += len(raw)
            require(total <= MAX_RESPONSE_BYTES, "stream exceeded probe evidence bound")
            line = raw.strip()
            if not line.startswith(b"data:"):
                continue
            data = line[5:].strip()
            if data == b"[DONE]":
                done = True
                break
            event = json.loads(data)
            event_count += 1
            output.extend(str(choice.get("delta", {}).get("content") or "")
                          for choice in event.get("choices", []))
    content = "".join(output).strip().encode("utf-8")
    return {
        "httpStatus": status, "durationMs": round((time.monotonic() - started) * 1000, 3),
        "eventCount": event_count, "done": done, "contentBytes": len(content),
        "contentDigest": digest(content),
    }


def cancel_probe(base_url: str, model: str) -> dict[str, Any]:
    cancel_body = body(model, [
        {"role": "user", "content": "Count slowly from 1 to 1000."},
    ], max_tokens=2048)
    cancel_body["stream"] = True
    payload = json.dumps(cancel_body, separators=(",", ":")).encode("utf-8")
    target = urllib.parse.urljoin(base_url.rstrip("/") + "/", "v1/chat/completions")
    req = urllib.request.Request(
        target, data=payload, method="POST",
        headers={"Accept": "text/event-stream", "Content-Type": "application/json"},
    )
    started = time.monotonic()
    events = 0
    response = urllib.request.urlopen(req, timeout=300)
    try:
        for raw in response:
            if raw.strip().startswith(b"data:"):
                events += 1
            if events >= 2:
                break
    finally:
        response.close()
    time.sleep(1)
    status, _ = request(base_url, "/health", timeout=30)
    return {
        "connectionClosedEarly": True, "eventsBeforeClose": events,
        "runtimeHealthyAfterClose": status == 200,
        "durationMs": round((time.monotonic() - started) * 1000, 3),
    }


def concurrent_probe(base_url: str, model: str) -> dict[str, Any]:
    prompts = ("PARALLEL_A", "PARALLEL_B")

    def invoke(expected: str) -> dict[str, Any]:
        _, summary = completion(base_url, body(model, [
            {"role": "system", "content": "Return the requested marker exactly."},
            {"role": "user", "content": "Reply exactly: " + expected},
        ], max_tokens=32))
        return summary

    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(invoke, prompts))
    return {
        "requestCount": len(results),
        "allSucceeded": all(item["httpStatus"] == 200 and item["contentBytes"] > 0 for item in results),
        "maximumConcurrentRequests": 2,
        "durationMs": round((time.monotonic() - started) * 1000, 3),
        "resultDigests": [item["contentDigest"] for item in results],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    args = parser.parse_args()
    status, raw = request(args.base_url, "/v1/models", timeout=30)
    model_ids = [str(item.get("id")) for item in json.loads(raw).get("data", [])]
    require(status == 200 and model_ids == [args.model], "served model identity mismatch")
    answer = answer_probe(args.base_url, args.model)
    agent = agent_probe(args.base_url, args.model)
    context_32k = context_32k_probe(args.base_url, args.model)
    streaming = stream_probe(args.base_url, args.model)
    cancellation = cancel_probe(args.base_url, args.model)
    concurrency = concurrent_probe(args.base_url, args.model)
    checks = {
        "answer": (answer["arithmetic"]["contentEquals714"]
                   and answer["chinese"]["contentContainsCjk"]),
        "agent_tool_loop": agent["completedToolLoop"],
        "context_32k": context_32k["nearWindowAccepted"],
        "streaming": streaming["httpStatus"] == 200 and streaming["done"]
                     and streaming["contentBytes"] > 0,
        "cancellation": cancellation["eventsBeforeClose"] >= 1
                        and cancellation["runtimeHealthyAfterClose"],
        "two_concurrent": concurrency["requestCount"] == 2 and concurrency["allSucceeded"],
    }
    failed = sorted(name for name, passed in checks.items() if not passed)
    result = {
        "schemaVersion": 1, "model": args.model,
        "modelsEndpoint": {"httpStatus": status, "ids": model_ids},
        "answer": answer, "agent": agent, "context32k": context_32k,
        "streaming": streaming,
        "cancellation": cancellation, "concurrency": concurrency,
        "checks": checks, "failedChecks": failed,
        "contentRetained": False, "syntheticPromptsOnly": True,
        "passed": not failed,
    }
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    require(not failed, "protected Qwen3.8 protocol matrix failed: " + ",".join(failed))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
