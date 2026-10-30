"""Read-only inspection of the one installed appliance; no registration or rollout."""
import hashlib
import json
from appliance_operations import ROOT, run, need

E = ROOT / 'evidence/validation/feature-deployments'
INSPECTOR = ROOT / 'tools/inspect_appliance.mjs'

def inspect_appliance(api_id, run_id, *, host, node_id, generation):
    request = dict(nodeId=node_id, nodeGeneration=generation, runId=run_id)
    return json.loads(run(host, ['docker', 'exec', '-i', api_id, 'node',
                                '--input-type=module', '-', json.dumps(request)],
                          input=INSPECTOR.read_bytes(), timeout=50))

def exact_appliance(value, agent):
    need(value['status'] == 'passed' and value['observationWindowReset'] is False
         and value['workloadsMutated'] is False, 'appliance_probe_invalid')
    observed = value['identity']
    need(observed['healthy'] is True and observed['imageDigest'] == agent['imageId']
         and observed['configurationDigest'] == agent['configDigest'], 'appliance_identity_mismatch')

def historical_record(path):
    value = json.loads(path.read_bytes())
    encoded = json.dumps({key:item for key,item in value.items() if key!='evidenceDigest'},
                         sort_keys=True,separators=(',',':')).encode()
    need(value['status']=='passed' and value['evidenceDigest'].removeprefix('sha256:') == hashlib.sha256(encoded).hexdigest(),
         'historical_record_changed')
    return value
