# Versioned model task-quality suites

Team AI Box quality certification uses immutable task suites rather than a
single generic “model quality” score. The initial catalog is
`models/quality-suite-catalog.v1.json`; changing a threshold, slice, metric,
evaluator, seed, or corpus policy creates a new suite digest and requires a new
validation run.

## Initial gates

| Task | Required quality dimensions |
| --- | --- |
| LLM/Agent | reasoning exact match, instruction following, tool-call schema validity, structured output validity, unsupported-claim rate |
| OCR | character/word error, layout block F1, table structure TEDS, reading order |
| ASR | word error, language identification, timestamp error, diarization error, long-audio coverage |
| Translation | COMET, chrF, terminology, numeric/entity preservation, segment alignment |
| Image drawing | prompt adherence, CLIP similarity, aesthetic score, severe defects, policy violations |

Every suite also fixes a minimum corpus size and required slices. For example,
ASR cannot pass using only clean English clips: Chinese, noisy, long-audio, and
multi-speaker slices all need their minimum coverage.

The initial numeric thresholds are conservative product policy and are not a
claim that any candidate already passes. Corpus content is imported separately
into protected object storage. A validation plan pins its exact corpus digest,
so licensed/private corpora do not need to live in source control and cannot be
silently substituted.

## Deterministic evaluation

The normalized suite pins a digest-addressed ARM64 evaluator image, evaluator
implementation digest, allowed seeds, aggregation, metric direction, threshold,
minimum samples, and optional maximum regression from a baseline profile. An
execution is rejected before scoring if any suite, corpus, profile, baseline,
image, implementation, seed, case count, slice, measurement, or time interval
does not match.

All required measurements must pass. Missing and non-finite values fail closed;
averaging a weak slice into a strong aggregate is not allowed. Low-precision
profiles may therefore pass an absolute floor yet still fail because their
delta from the pinned higher-precision baseline exceeds the per-metric budget.

The evaluator returns a content-addressed report. The ten-stage model validation
service accepts a passing Quality stage only when its suite digest, corpus
digest, profile fingerprint, report digest, outcome, and zero failed-measurement
count match the immutable validation plan. The full report remains protected
validation evidence.
