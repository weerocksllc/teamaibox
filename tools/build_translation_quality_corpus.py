#!/usr/bin/env python3
"""Build the exact transient FLORES-200 translation corpus from its locked archive."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import random
import re
import tarfile
import unicodedata


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SPEC = ROOT / "models" / "translation-quality-corpus.flores200.v1.json"


class CorpusError(ValueError):
    pass


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(block)
    return "sha256:" + value.hexdigest()


def canonical_digest(value: object) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return "sha256:" + hashlib.sha256(raw).hexdigest()


LATIN_TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9_.+/-]{1,}")


def shared_terminology(source: str, reference: str) -> list[str]:
    def tokens(value: str) -> set[str]:
        return {item.casefold() for item in LATIN_TOKEN.findall(unicodedata.normalize("NFKC", value))
                if len(item) >= 3}
    return sorted(tokens(source) & tokens(reference))


def read_member(archive: tarfile.TarFile, language: str) -> list[str]:
    name = f"./flores200_dataset/devtest/{language}.devtest"
    try:
        member = archive.getmember(name)
        handle = archive.extractfile(member)
    except (KeyError, tarfile.TarError) as error:
        raise CorpusError(f"missing locked corpus member: {name}") from error
    if handle is None or not member.isfile():
        raise CorpusError(f"invalid locked corpus member: {name}")
    return handle.read().decode("utf-8").splitlines()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--spec", type=Path, default=DEFAULT_SPEC)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    spec = json.loads(args.spec.read_text(encoding="utf-8"))
    if digest(args.archive) != spec["source"]["archiveSha256"] or args.archive.stat().st_size != spec["source"]["archiveBytes"]:
        raise CorpusError("FLORES-200 archive digest or size drifted")
    directions = spec["selection"]["directions"]
    selected: list[dict[str, object]] = []
    with tarfile.open(args.archive, "r:gz") as archive:
        cache = {lang: read_member(archive, lang) for item in directions for lang in (item["source"], item["target"])}
    for direction in directions:
        source = cache[direction["source"]]
        target = cache[direction["target"]]
        if len(source) != len(target) or len(source) < direction["count"]:
            raise CorpusError("parallel FLORES-200 members are not aligned")
        indexes = list(range(len(source)))
        random.Random(f"{spec['selection']['seed']}:{direction['source']}:{direction['target']}").shuffle(indexes)
        for index in indexes[:direction["count"]]:
            selected.append({
                "caseId": f"{direction['source']}-{direction['target']}-{index:04d}",
                "sliceKey": direction["sliceKey"],
                "sourceLanguage": direction["bcp47Source"],
                "targetLanguage": direction["bcp47Target"],
                "source": source[index],
                "reference": target[index],
                "sourceIndex": index,
            })
    selected.sort(key=lambda item: (
        str(item["sourceLanguage"]),
        str(item["targetLanguage"]),
        hashlib.sha256(
            f"{spec['selection']['seed']}:{item['caseId']}:{item['source']}:{item['reference']}".encode()
        ).hexdigest(),
    ))
    numeric = [item for item in selected if any(ch.isdecimal() for ch in unicodedata.normalize("NFKC", str(item["source"])))]
    terminology = [(item, shared_terminology(str(item["source"]), str(item["reference"]))) for item in selected]
    terminology = [(item, terms) for item, terms in terminology if terms]
    if len(numeric) < spec["selection"]["numericEntityCases"]:
        raise CorpusError("locked selection lacks the required real numeric-entity cases")
    if len(terminology) < spec["selection"]["terminologyCases"]:
        raise CorpusError("locked selection lacks the required exact shared terminology cases")
    terminology_map = {item["caseId"]: terms for item, terms in terminology[:spec["selection"]["terminologyCases"]]}
    subtitle_ids = {item["caseId"] for item in selected[:spec["selection"]["subtitleSegmentCases"]]}
    numeric_ids = {item["caseId"] for item in numeric}
    for item in selected:
        item["slices"] = sorted({"overall", item["sliceKey"], *(
            ["terminology"] if item["caseId"] in terminology_map else []), *(
            ["subtitle-segments"] if item["caseId"] in subtitle_ids else []), *(
            ["numeric-entity"] if item["caseId"] in numeric_ids else [])})
        item["requiredTerms"] = terminology_map.get(item["caseId"], [])
    output = {
        "schemaVersion": 1,
        "corpusKey": spec["corpusKey"],
        "version": spec["version"],
        "specDigest": canonical_digest(spec),
        "archiveDigest": spec["source"]["archiveSha256"],
        "caseCount": len(selected),
        "cases": selected,
    }
    output["corpusDigest"] = canonical_digest(output)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({"caseCount": len(selected), "corpusDigest": output["corpusDigest"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
