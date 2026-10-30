# Scoped artifact handoffs

Team AI Box transfers application data through encrypted immutable object
versions. A caller never passes a blob-store credential to another application.
It receives a short-lived reference bound to one object version, issuer,
audience, operation set, integrity hash and expiry.

The durable record is the artifact provenance ID. It contains verified object
facts, producer identity, bounded metadata and source edges. Reference IDs and
tokens are deliberately excluded so application databases remain useful after
a reference expires without becoming credential stores.

## Application boundaries

| Producer or consumer | Required audience | Durable artifact kind |
| --- | --- | --- |
| Messaging upload | `messaging.attachment` | `chat-attachment` |
| Team Drive file commit | `team-drive.file` | `drive-file` |
| Assistant input | `assistant.input` | `ai-input` |
| Agent output | `assistant.artifact` | `agent-artifact` |
| OCR, ASR, translation or drawing input | `compute:<capability>` | existing source or `ai-input` |
| Durable compute result | `compute.user-result` | `ai-result` |
| Model registry import | `model-registry.artifact` | existing `model-artifact` |

The same reference cannot be replayed under a different audience or issuer.
Workers and applications receive only the minimum operations (`head`, `read`
and `range`) and at most a 15-minute lifetime. Durable jobs resolve incoming
references before persistence, retain immutable input facts, and register
completed output references with source lineage.

## Provenance examples

- An OCR output saved to Team Drive records `drive-file → export-of → ai-result`
  and the AI result retains its source image and compute job.
- An Agent-generated report records `agent-artifact → derived-from → ai-input`.

Provenance records and source edges are immutable. Consumption creates an
append-only redacted handoff event. Deleting or expiring a scoped reference does
not erase the provenance graph, while object deletion or integrity mismatch
causes future issuance to fail closed.
