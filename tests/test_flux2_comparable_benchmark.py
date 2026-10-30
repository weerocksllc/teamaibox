from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_benchmark_uses_cgroup_peak_and_common_conditions() -> None:
    source = (ROOT / "tools/run_flux2_comparable_benchmark.py").read_text(encoding="utf-8")
    assert "memory.peak" in source
    assert '"sameResolution": "512x512"' in source
    assert '"sameSteps": 4' in source
    assert "Do not claim universal NVFP4 speedup" in source


def test_probe_has_one_cold_and_three_warm_seeds() -> None:
    source = (ROOT / "tools/flux2_comparable_benchmark_probe.py").read_text(encoding="utf-8")
    assert "SEEDS = (42001, 42002, 42003, 42004)" in source
    assert 'JOB_IDS = tuple(f"42000000-0000-4000-8000-{index:012d}"' in source
    assert '"cold" if index == 0 else "warm"' in source
    assert "num_inference_steps=4" in source


def test_validator_keeps_certification_and_product_claims_false() -> None:
    source = (ROOT / "tools/validate_flux2_comparable_benchmark.py").read_text(encoding="utf-8")
    assert '"certified": False' in source
    assert '"productRouted": False' in source
