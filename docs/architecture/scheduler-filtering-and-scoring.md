# Scheduler filtering and scoring

OpenSpec task 5.4 introduces a pure, deterministic decision core. Its input is
a durable queued job, one or more expanded target/model-profile pairs, current
fair-share state, and administrator routing policy. It does not mutate queue
state, acquire resources, or start workers.

## Decision sequence

1. Reject disabled, unhealthy, or unknown-health targets.
2. Require the exact requested capability/profile and a `certified` profile.
3. Enforce architecture and operation compatibility.
4. Enforce data class and explicit external-processing policy.
5. Observe actual target health without deducting declared resource totals.
6. Enforce accelerator kind/precision/compute capability,
   storage class, and network class/latency requirements declared under
   `ModelProfile.extensions.schedulerRequirements`.
7. Enforce hierarchical user/team/capability quota and concurrency policy.
8. Score only the remaining candidates, then use profile ID and target ID as
   deterministic tie-breakers.

The scheduler result has three collections/fields useful to later control
plane integrations:

- `eligible`: ranked target/profile decisions with total and component score;
- `rejected`: target/profile decisions with stable, structured reasons;
- `selected`: the first eligible decision, or `null` plus
  `waitingReason: "no_eligible_target"`.

`reasonCounts` is safe operational metadata. Client APIs still expose logical
models and task wait state and do not reveal physical container addresses,
provider endpoints, or secrets.

## Resource evidence

For the local appliance, actual memory, CPU and network observations are
telemetry, not an advance allocation ledger. Declared model/guest maxima are
not summed and subtracted to reject new work. DGX Spark unified memory remains
one physical memory domain; no synthetic dedicated-VRAM pool is created.

External providers frequently do not disclose hardware counters. A target can
therefore use `provider_contract` accounting only when it is an
`external_provider` and supplies known available/max concurrency. Hardware
headroom is then not inferred; certification, API mapping, health, data class,
external approval, and provider concurrency remain mandatory.

## Model profile scheduling extensions

The immutable profile's standard `resourceEnvelope` carries numeric CPU,
unified-memory, accelerator-unit, codec-session, storage, and network needs.
Optional exact constraints use this extension shape:

```json
{
  "extensions": {
    "schedulerRequirements": {
      "acceleratorKinds": ["nvidia-blackwell"],
      "minimumComputeCapability": "12.0",
      "codecDirections": {"encode": 1, "decode": 1},
      "storageClass": "encrypted_nvme"
    }
  }
}
```

Because the extension is part of an immutable certified profile, changing it
requires a new profile and validation evidence rather than silently changing
production routing.

## Scoring and fairness

Default score weights total 100:

| Component | Weight | Meaning |
| --- | ---: | --- |
| Load cost | 25 | Warm/preparing state, certified cold-start estimate, cached artifact |
| Locality | 20 | Input-object locality, model cache, local model cache |
| Capacity headroom | 20 | Remaining schedulable capacity after placement |
| Queue fairness | 10 | Dominant normalized user/team/capability usage |
| Network | 10 | Bandwidth headroom and observed latency where applicable |
| Routing weight | 15 | Monotonic administrator/provider preference |

The score is an explanation and ordering input, not a capacity reservation.
Before dispatch, recheck node identity, health, ownership and operation fencing.
Scores never create an advance resource entitlement.

Queue ordering uses effective priority first, a bounded minute-based wait boost
to prevent starvation, dominant fair share second, and FIFO plus job ID for a
stable final order. Exhausted quota or concurrency is an admission block rather
than an arbitrarily low score, so the task center can show the actual reason.

