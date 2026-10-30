#!/usr/bin/env python3
"""Strictly validate exact FLUX.2 common-corpus quality comparison."""
from __future__ import annotations
import argparse,hashlib,json,subprocess
from pathlib import Path
try:
    from .run_spark_model_baseline import canonical_digest
except ImportError:
    from run_spark_model_baseline import canonical_digest
ROOT=Path(__file__).resolve().parents[1]
SOURCES=("models/drawing-quality-corpus.synthetic.v1.json","tools/generate_drawing_quality_corpus.py","tools/flux2_quality_probe.py","tools/run_flux2_quality_comparison.py","tools/validate_flux2_quality_comparison.py","tests/test_flux2_quality_comparison.py")
def req(v:bool,m:str)->None:
    if not v:raise ValueError(m)
def sha(b:bytes)->str:return "sha256:"+hashlib.sha256(b).hexdigest()
def validate(path:Path)->dict:
    v=json.loads(path.read_text());req(v.get("runnerId")=="teamaibox.flux2-quality-comparison.v1" and v.get("status")=="passed" and v.get("failure") is None,"quality evidence failed")
    d=v.get("evidenceDigest");req(d==canonical_digest({k:x for k,x in v.items() if k!="evidenceDigest"}),"digest drifted")
    b={x["path"]:x["sha256"] for x in v["sources"]};req(set(b)==set(SOURCES),"source bindings incomplete")
    for n in SOURCES:req(b[n]==sha((ROOT/n).read_bytes()),"source drifted: "+n)
    req(v["corpus"]["caseCount"]==50 and set(v["corpus"]["sliceCounts"].values())=={10},"corpus coverage invalid")
    for p in ("bf16","nvfp4"):
        q=v["profiles"][p]["probe"]["quality"];req(q["caseCount"]==50 and q["distinctOutputs"]==50 and q["unloaded"],"profile quality incomplete")
        req(q["aggregate"]["overall"]["samples"]==50,"overall quality incomplete")
    req(all(isinstance(x,bool) for x in v["decision"]["gates"].values()),"quality gates invalid")
    req(v["claimBoundary"]["commonQualityCompared"] and not v["claimBoundary"]["certified"] and not v["claimBoundary"]["productRouted"],"claim boundary invalid")
    c=v["cleanup"];req(c["containersRemoved"] and c["runRootAbsent"] and c["workersRestoredExact"] and not c["restoreErrors"],"cleanup incomplete")
    return {"valid":True,"runId":v["runId"],"evidenceDigest":d,"nvfp4QualityWithinBudget":v["decision"]["nvfp4QualityWithinBudget"]}
def main()->int:
    p=argparse.ArgumentParser(description=__doc__);p.add_argument("--evidence",type=Path,required=True);print(json.dumps(validate(p.parse_args().evidence.resolve()),sort_keys=True,separators=(",",":")));return 0
if __name__=="__main__":
    try:raise SystemExit(main())
    except (OSError,ValueError,KeyError,json.JSONDecodeError,subprocess.TimeoutExpired) as e:raise SystemExit("FLUX.2 quality validation failed: "+str(e))
