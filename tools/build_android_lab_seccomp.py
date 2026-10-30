#!/usr/bin/env python3
"""Permit only AF_VSOCK on top of an exact upstream Moby default profile."""
import argparse
import hashlib
import json
from pathlib import Path

PARENT_SHA = '536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74'
PARENT_URL = 'https://raw.githubusercontent.com/moby/profiles/3c28324314729dbade8287e868eef6338c42807a/seccomp/default.json'
VSOCK_RULE = {'names': ['socket'], 'action': 'SCMP_ACT_ALLOW',
              'args': [{'index': 0, 'value': 40, 'op': 'SCMP_CMP_EQ'}]}


def extend(raw):
    if hashlib.sha256(raw).hexdigest() != PARENT_SHA:
        raise ValueError('upstream default profile digest mismatch')
    data = json.loads(raw)
    assert data['defaultAction'] == 'SCMP_ACT_ERRNO'
    data['syscalls'].append(VSOCK_RULE)
    return (json.dumps(data, indent=2)+'\n').encode()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    raw = extend(Path(args.source).read_bytes())
    with Path(args.output).open('xb') as stream:
        stream.write(raw)
    print(json.dumps({'parent': PARENT_URL, 'parentSha256': PARENT_SHA,
                      'profileSha256': hashlib.sha256(raw).hexdigest(),
                      'onlyAddedRule': VSOCK_RULE}))
