# Immutable model profile registration

`ModelProfile` is the revisioned, immutable deployment identity for one exact
model and engine combination. A material change never edits an existing
profile: the administrator registers a new `profileKey`, and routing or
certification can then move to that identity explicitly.

The v1 declaration fails closed unless it pins all deployment facts needed to
reproduce and schedule the profile:

- source model and revision, structured license review and provenance;
- every artifact checksum and size, plus the primary artifact digest;
- engine, runtime, container image, and configuration digests;
- precision and, for every quantized profile, the exact tool, recipe,
  parameters, and optional calibration dataset digests;
- supported architecture, hardware requirements, software compatibility
  ranges, API contracts, request limits, cold-start facts, and known limits;
- unified-memory resource envelope, data policy, and immutable validation-run
  references.

NVFP4 is not a marketing alias: an NVFP4 profile is rejected unless its exact
quantization recipe declares the `nvfp4` scheme. Local appliance
profiles require observed CPU and unified-memory values. External OpenAI-style
providers instead use `provider_contract` accounting and declare concurrency
and request limits while all local physical-resource fields remain zero. This
prevents the scheduler and dashboard from presenting invented A100/H200 or
other remote hardware telemetry as appliance capacity.

The registration service requires `model:manage`, canonicalizes the strict
declaration, calculates a SHA-256 fingerprint, creates one UUID identity, and
starts it in `discovery`. Exact replays return the original document; reuse of
the same key for a changed fingerprint is rejected. Secret-shaped extension
keys and credential-bearing source URLs are also rejected.

PostgreSQL writes the query projection and complete immutable document in one
transaction. The registration table has uniqueness constraints for profile
key, fingerprint, and operation key, plus a mutation trigger that rejects
updates and deletes. A restricted foreign key prevents deletion of the parent
projection. Certification transitions and routing eligibility are separate
append-only concerns implemented by the certification pipeline.

The public shape is defined by
`packages/contracts/compute/model-profile.v1.schema.json`; the JavaScript
validator remains stricter at trust boundaries and returns only canonical
values.

