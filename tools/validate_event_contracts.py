#!/usr/bin/env python3
"""Validate durable event topology and envelope contract sources."""

from __future__ import annotations

import json
import pathlib
import re
from typing import Any, Mapping


ROOT = pathlib.Path(__file__).resolve().parents[1]
TOPOLOGY = ROOT / "packages" / "event-bus" / "topology.v1.json"
ENVELOPE = ROOT / "packages" / "contracts" / "events" / "event-envelope.v1.schema.json"
SUBJECT = re.compile(r"^teamaibox\.(events|commands)\.v1\.>$")


class EventContractError(ValueError):
    pass


def validate(topology: Mapping[str, Any], envelope: Mapping[str, Any]) -> dict[str, int]:
    if topology.get("schemaVersion") != 1 or topology.get("domainPrefix") != "teamaibox":
        raise EventContractError("topology must be Team AI Box schema version 1")
    if topology.get("singleNodeReplicas") != 1:
        raise EventContractError("single-node foundation must declare one replica")
    streams = topology.get("streams")
    if not isinstance(streams, list) or len(streams) != 2:
        raise EventContractError("events and commands streams are required")
    names: set[str] = set()
    subjects: set[str] = set()
    for stream in streams:
        if not isinstance(stream, Mapping):
            raise EventContractError("stream definitions must be objects")
        name = stream.get("name")
        if not isinstance(name, str) or name in names:
            raise EventContractError("stream names must be unique strings")
        names.add(name)
        stream_subjects = stream.get("subjects")
        if not isinstance(stream_subjects, list) or len(stream_subjects) != 1:
            raise EventContractError(f"{name} must own exactly one versioned wildcard")
        subject = stream_subjects[0]
        if not isinstance(subject, str) or not SUBJECT.fullmatch(subject) or subject in subjects:
            raise EventContractError(f"{name} has an invalid or overlapping subject")
        subjects.add(subject)
        if stream.get("storage") != "file":
            raise EventContractError(f"{name} must use file storage")
        if stream.get("retention") not in {"limits", "workqueue"}:
            raise EventContractError(f"{name} has an unsupported retention policy")
        for field in ("maxAgeSeconds", "maxBytes", "duplicateWindowSeconds"):
            if not isinstance(stream.get(field), int) or stream[field] <= 0:
                raise EventContractError(f"{name}.{field} must be positive")
    if subjects != {"teamaibox.events.v1.>", "teamaibox.commands.v1.>"}:
        raise EventContractError("required v1 event and command subjects are missing")

    defaults = topology.get("consumerDefaults")
    if not isinstance(defaults, Mapping):
        raise EventContractError("consumer defaults are required")
    if defaults.get("ackPolicy") != "explicit" or defaults.get("maxDeliver", 0) < 2:
        raise EventContractError("durable consumers require explicit ack and redelivery")
    headers = topology.get("publishHeaders")
    if not isinstance(headers, Mapping) or headers.get("Nats-Msg-Id") != "eventId":
        raise EventContractError("publishers must deduplicate with eventId")

    if envelope.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
        raise EventContractError("event envelope must use JSON Schema 2020-12")
    required = envelope.get("required")
    properties = envelope.get("properties")
    required_fields = {
        "eventId",
        "eventType",
        "schemaVersion",
        "subject",
        "aggregate",
        "occurredAt",
        "payload",
    }
    if not isinstance(required, list) or not required_fields.issubset(required):
        raise EventContractError("event envelope required fields are incomplete")
    if not isinstance(properties, Mapping) or properties.get("payload", {}).get("type") != "object":
        raise EventContractError("event payload must be a JSON object")
    return {"streams": len(streams), "requiredEnvelopeFields": len(required_fields)}


def main() -> int:
    topology = json.loads(TOPOLOGY.read_text(encoding="utf-8"))
    envelope = json.loads(ENVELOPE.read_text(encoding="utf-8"))
    summary = validate(topology, envelope)
    print(
        f"event contracts valid: {summary['streams']} durable streams, "
        f"{summary['requiredEnvelopeFields']} required envelope fields"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

