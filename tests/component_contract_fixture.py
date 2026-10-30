"""In-memory validator fixtures, never qualification or deployment evidence.

The archived report supplies schema examples. Bind its source fields to today's
files so mutation tests reach the rule under test instead of all failing on an
unrelated old hash. No evidence file is edited or written, no real test result
is claimed, and default CLI validation remains strict.
"""
import copy
import json


def component_contract_fixture(path, validator):
    value=copy.deepcopy(json.loads(path.read_text(encoding='utf-8')))
    value['contracts']=copy.deepcopy(validator.EXPECTED_CONTRACTS)
    value['sourceBindings']=[dict(path=relative,owners=list(owners),
        digest=validator.digest_bytes((validator.ROOT/relative).read_bytes()))
        for relative,owners in validator.SOURCE_OWNERS.items()]
    value['evidenceDigest']=validator.digest_bytes(validator.canonical_bytes({
        k:v for k,v in value.items() if k!='evidenceDigest'}))
    return value
