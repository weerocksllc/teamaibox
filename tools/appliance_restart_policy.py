"""Build a local restart policy from exact installed container identities.

No SSH, Docker calls, credential output or mutations occur on import. The caller
must compute configuration digests with the Agent's Docker normalization helper.
"""
import hashlib
import json
import re


def build_restart_policy(node_id, generation, platform, node_agent):
    if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', node_id):
        raise ValueError('invalid appliance identity')
    if type(generation) is not int or generation < 1:
        raise ValueError('invalid appliance generation')

    def target(value):
        expected = {'containerName', 'imageId', 'imageReference', 'configurationDigest', 'requireHealthy'}
        if set(value) != expected or value['requireHealthy'] is not True:
            raise ValueError('exact healthy restart target required')
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', value['containerName']):
            raise ValueError('invalid restart container name')
        for key in ('imageId', 'configurationDigest'):
            if not re.fullmatch(r'sha256:[a-f0-9]{64}', value[key]):
                raise ValueError('invalid restart identity digest')
        reference = value['imageReference']
        if not isinstance(reference, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/@-]{3,511}', reference):
            raise ValueError('invalid restart image reference')
        # Match the Go wire struct's field order, including an empty digest.
        return {key: value[key] for key in ('containerName', 'imageId', 'imageReference', 'configurationDigest', 'requireHealthy')}

    value = dict(schemaVersion=1, nodeId=node_id, nodeGeneration=generation,
                 policyDigest='', platform=target(platform), nodeAgent=target(node_agent))
    if value['platform']['containerName'] == value['nodeAgent']['containerName']:
        raise ValueError('restart targets must be distinct')
    raw = json.dumps(value, separators=(',', ':'), ensure_ascii=True).encode()
    value['policyDigest'] = 'sha256:' + hashlib.sha256(raw).hexdigest()
    return value
