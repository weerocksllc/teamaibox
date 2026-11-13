# Retired validation entrypoints

The following runners belong to the previous private, OpenSpec-based qualification
workflow. They reference historical catalogs, reports or helper scripts that are
not part of the current public build. Their command-line entrypoints are retired
and fail before running checks or writing reports:

- `tools/run_current_supported_environment_v2_qualification.py`
- `tools/run_current_supported_records_v3_qualification.py`
- `tools/run_current_supported_records_v4_qualification.py`
- `tools/run_airplay_compatible_source_readiness.py`
- `tools/run_release_candidate_gate.py`

Their imported execution helpers also refuse new runs. The three corresponding
`validate_current_supported_*_qualification.py` readers reject `live_commands=True`,
and `validate_airplay_compatible_source_readiness.py` rejects `revalidate=True`.
Explicit record-only validation remains available without rerunning commands.

Do not install OpenSpec, recreate private catalogs, or remove a failing predicate
to obtain a pass. New work uses the scoped acceptance plan described in the
[project handbook](README.md) and the applicable public source/release documents.
Publication still requires explicit authorization and relevant acceptance.

Historical reader functions, schema keys such as `strictOpenSpec`, signed-review
wording and original test fixtures may remain for interpreting old records. They
are not active project instructions. Their presence must not cause new OpenSpec
commands, rewrite old evidence or broaden current test scope.

Retiring a runner is not a release approval. Package integrity, licensing,
security, data preservation and actual user-flow checks remain necessary when
relevant to the candidate being delivered. A replacement automated promotion
system is not introduced by this documentation migration.
