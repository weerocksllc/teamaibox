#!/usr/bin/env python3
"""Strictly validate real-browser live-preference evidence for every official ApplicationPlugin."""
from __future__ import annotations
import argparse, hashlib, json, re
from pathlib import Path
from typing import Any, Mapping, Sequence
from validation_origin import is_https_origin

ROOT = Path(__file__).resolve().parents[1]
HISTORICAL_RUNNERS = ROOT / "architecture/validation/historical-official-plugin-preference-runner-digests.v1.json"
SHA = re.compile(r"^sha256:[0-9a-f]{64}$")
UTC = re.compile(r"^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$")
APPS = ["official.messaging","official.team-drive","official.drawing","official.ocr","official.asr","official.translation"]
class EvidenceError(RuntimeError): pass
def require(value: Any, message: str) -> None:
    if not value: raise EvidenceError(message)
def digest(value: bytes) -> str: return "sha256:" + hashlib.sha256(value).hexdigest()
def canonical(value: Any) -> bytes: return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
def repository_file(value: str) -> Path:
    path=(ROOT/value).resolve(); require(path.is_file() and ROOT in path.parents, "evidence reference escapes repository"); return path
def validate(path: Path) -> Mapping[str, Any]:
    path=path.resolve(); require(path.is_file() and ROOT in path.parents, "official preference evidence is unavailable")
    value=json.loads(path.read_text(encoding="utf-8")); require(value.get("schemaVersion")==1 and value.get("runnerId")=="teamaibox.official-plugin-preference-browser-smoke.v1", "official preference identity drifted")
    require(value.get("status")=="passed" and value.get("failure") is None
            and value.get("featureKey") in {"admin.plugins", "admin.encryption"}, "official preference run did not pass")
    require(is_https_origin(value.get("origin"), trailing_slash=True), "official preference origin is invalid")
    require(all(isinstance(value.get(key),str) and UTC.fullmatch(value[key]) for key in ("startedAt","completedAt")), "official preference timestamps are invalid")
    browser=value.get("browser"); require(isinstance(browser,Mapping) and set(browser)=={"platform","userAgent"} and "HeadlessChrome/" in str(browser["userAgent"]), "real Chrome identity is missing")
    deployment=value.get("deployment"); require(isinstance(deployment,Mapping) and set(deployment)=={"evidencePath","evidenceDigest","runId","webImageId","platformApiImageId"}, "deployment binding fields drifted")
    parent=repository_file(deployment["evidencePath"]); parent_bytes=parent.read_bytes(); parent_value=json.loads(parent_bytes)
    require(deployment["evidenceDigest"]==digest(parent_bytes) and deployment["runId"]==parent_value.get("runId")
            and parent_value.get("status")=="passed" and value["featureKey"]==parent_value.get("featureKey"), "deployment parent binding changed")
    require(all(SHA.fullmatch(deployment[key] or "") for key in ("webImageId","platformApiImageId")), "platform image binding is invalid")
    applications=value.get("applications"); require(isinstance(applications,list) and [item.get("key") for item in applications]==APPS, "official application coverage drifted")
    screenshots=set()
    for item in applications:
        require(set(item)=={"key","imageId","initialRevision","englishRevision","finalRevision","semanticTokenCount","iframeIdentityPreserved","inputStatePreserved","englishLightApplied","chineseDarkApplied","mobileNoOverflow","screenshot"}, f"{item.get('key')} fields drifted")
        require(SHA.fullmatch(item["imageId"] or "") and item["semanticTokenCount"]==38 and 1<=item["initialRevision"]<item["englishRevision"]<item["finalRevision"], f"{item['key']} token or revision evidence is invalid")
        require(all(item[key] is True for key in ("iframeIdentityPreserved","inputStatePreserved","englishLightApplied","chineseDarkApplied","mobileNoOverflow")), f"{item['key']} live preference operation failed")
        shot=item["screenshot"]; require(isinstance(shot,Mapping) and set(shot)=={"path","digest"}, "screenshot binding drifted"); target=repository_file(shot["path"]); content=target.read_bytes()
        require(target.suffix==".png" and content.startswith(b"\x89PNG\r\n\x1a\n") and shot["digest"]==digest(content) and target not in screenshots, "screenshot changed or was reused"); screenshots.add(target)
    require(value.get("screenshots")==[item["screenshot"] for item in applications] and len(screenshots)==len(APPS), "screenshot aggregate drifted")
    require(value.get("console")=={"errorCount":0} and value.get("privacy")=={"credentialsRetained":False,"userContentRetained":False,"commandOutputRetained":False,"syntheticContentOnly":True}, "console or privacy evidence drifted")
    limitations=value.get("limitations"); require(isinstance(limitations,Mapping) and limitations.get("assistantApplication")=="not_in_plugin_sdk_scope" and limitations.get("fullAccessibilityMatrix")=="not_performed" and limitations.get("trustedHttps")=="not_satisfied_by_self_signed_component_origin" and limitations.get("independentHumanAcceptance")=="not_performed", "official preference limitations drifted")
    source=value.get("source"); require(isinstance(source,Mapping) and set(source)=={"runnerDigest"} and SHA.fullmatch(source["runnerDigest"] or ""), "runner binding is invalid")
    runner=ROOT/"tools/run_official_plugin_preference_browser_smoke.mjs"
    historical=json.loads(HISTORICAL_RUNNERS.read_text(encoding="utf-8"))
    allowed={digest(runner.read_bytes()),*(item["digest"] for item in historical.get("retiredRunnerDigests",[]))}
    require(source["runnerDigest"] in allowed, "official preference runner changed")
    without=dict(value); claimed=without.pop("evidenceDigest",None); require(claimed==digest(canonical(without)), "official preference canonical digest changed")
    return {"valid":True,"runId":value["runId"],"status":value["status"],"deploymentRunId":deployment["runId"],"applicationCount":len(applications),"screenshotCount":len(screenshots)}
def main(argv: Sequence[str]|None=None)->int:
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("--evidence",type=Path,required=True);args=parser.parse_args(argv);print(json.dumps(validate(args.evidence),sort_keys=True,separators=(",",":")));return 0
if __name__=="__main__":
    try: raise SystemExit(main())
    except (EvidenceError,OSError,ValueError,json.JSONDecodeError) as error: print(f"official plugin preference evidence invalid: {error}");raise SystemExit(1)
