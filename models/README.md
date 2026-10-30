# Model discovery catalog

`candidate-matrix.v1.json` is the pre-download decision record for the first
model-validation cohort. It pins publisher revisions, license evidence,
artifact-size ceilings, precision applicability, initial engines, comparison
plans, and allow/block decisions.

Discovery is metadata-only. An `allowed` decision is not a certification: the
content-addressed importer must still enforce quota, fetch only allowlisted
files, verify every checksum, encrypt storage, and create an immutable
`ModelProfile`. A `blocked` candidate must not be downloaded until the recorded
reason is resolved and the matrix is revised.

Run `python3 tools/validate_model_candidates.py` before any model transfer.

`drawing-model-portfolio.v1.json` separates stable Drawing intent aliases from
exact local checkpoint candidates and provider-advertised external model IDs.
An entry is not a certification or routing approval: new candidates remain
fail-closed until exact Spark deployment, quality, resource, security and
product evidence passes. Run
`python3 tools/validate_drawing_model_portfolio.py` before candidate preparation
or product routing.

`non-llm-precision-applicability.v1.json` binds the reviewed candidate matrix
to explicit Applicable, Not Applicable, or Failed decisions for drawing, OCR,
ASR and translation low-precision paths. It prohibits artifact
download and forced conversion during applicability assessment. Validate it
with `python3 tools/validate_non_llm_precision_applicability.py`.

`quality-suite-catalog.v1.json` defines the first six task-quality gates for
LLM reasoning/instruction following, OCR text/layout, ASR language/timestamp/
speaker behavior, translation and image prompt adherence. The values are versioned product acceptance policy, not claims that
an untested model already achieves them. Every execution binds the catalog
suite digest to the exact protected corpus digest selected by its validation
plan.

`deploy/compute/model-baseline-deployments.v1.json` pins the executable
Qwen3.6 BF16 and publisher-prequantized NVFP4 Spark pair, their ARM64 NGC vLLM
manifest, node-exclusive resource floors, isolated runtime network, non-root
policy, engine arguments, and identical bounded evidence plan.
`tools/model_artifact_manifest.py`, `tools/model_baseline_probe.py`, and
`tools/run_spark_model_baseline.py` verify each exact snapshot, collect
content-safe quality/performance/resource and kernel facts, exercise three cold
loads, preserve core services, and unload with residual checks.
`tools/compare_llm_baselines.py` refuses comparison if corpus, seed, warmup,
context, output, batch, concurrency, environment, or non-precision engine
arguments differ. The procedure and its explicit non-certification boundary
are in `docs/operations/spark-initial-llm-baseline.md`.
