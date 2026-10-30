#!/usr/bin/env python3
"""Round-trip one synthetic file in an existing phone; never restart or replace it."""
import argparse
import hashlib
import json
import re
import ssl
import subprocess
import sys
import termios
import urllib.request
from probe_current_casting_controls import Client, ROOT, SSH, CA, ORIGIN, now


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--run-id', required=True)
    p.add_argument('--phone-id', required=True)
    a = p.parse_args()
    assert re.fullmatch(r'phone-storage-continuity-20\d{6}-a[1-9]\d*', a.run_id)
    assert re.fullmatch(r'[a-f0-9-]{36}', a.phone_id)
    output = ROOT / 'evidence/validation/virtual-phones' / (a.run_id + '.json')
    assert not output.exists(), 'exact_run_already_exists'
    tty = termios.tcgetattr(sys.stdin) if sys.stdin.isatty() else None
    if tty:
        hidden = list(tty)
        hidden[3] &= ~termios.ECHO
        termios.tcsetattr(sys.stdin, termios.TCSANOW, hidden)
    print('Waiting for test login on stdin', flush=True)
    try:
        credentials = json.loads(sys.stdin.readline())
    finally:
        if tty:
            termios.tcsetattr(sys.stdin, termios.TCSANOW, tty)
    report = dict(runId=a.run_id, startedAt=now(), status='failed', phoneId=a.phone_id,
                  scope=dict(authenticatedHttps=True, browserAcceptance=False,
                             restartRequested=False, wholeRelease=False), checks={})
    clients = []
    try:
        context = ssl.create_default_context(cadata=subprocess.check_output([*SSH, 'sudo', '-n', 'cat', CA], timeout=15).decode())
        first = Client(context)
        clients.append(first)
        first.login(credentials['loginName'], credentials['password'])
        base = '/api/v1/virtual-phones/' + a.phone_id
        before = first.ok(base)
        report['before'] = {k: before.get(k) for k in ('id', 'state', 'generation', 'romProfileId', 'nodeId')}
        assert before['state'] == 'running', 'phone_not_running'
        generation = before['generation']
        name = a.run_id + '.txt'
        raw = (a.run_id + '\nSINGLE-APPLIANCE-PERSISTENT-FILE\n').encode()
        digest = hashlib.sha256(raw).hexdigest()
        listed = first.ok(base + '/files?generation=' + str(generation))
        assert not any(f['name'] == name for f in listed['data']), 'synthetic_file_exists'
        opened = first.ok('/api/v1/objects/multipart', dict(capability='virtual_phone', name=name,
                          media_type='application/octet-stream', size=len(raw), sha256=digest))
        upload = opened['upload']['uploadId']
        request = urllib.request.Request(ORIGIN + '/api/v1/objects/multipart/' + upload + '/parts/1',
            method='PUT', data=raw, headers={'Content-Type':'application/octet-stream', 'Origin':ORIGIN,
            'x-csrf-token':first.csrf, 'x-content-sha256':digest})
        with first.opener.open(request, timeout=30) as response:
            json.load(response)
        obj = first.ok('/api/v1/objects/multipart/' + upload, dict(parts=[dict(part_number=1, sha256=digest)]))['object']
        assert obj['integrity']['digest'] == digest and obj['size'] == len(raw), 'object_mismatch'
        stored = first.ok(base + '/files', dict(expectedGeneration=generation, file=dict(
            objectId=obj['objectId'], objectVersion=obj['version'], name=name, sizeBytes=len(raw), sha256=digest)))
        assert stored['sha256'] == digest, 'phone_upload_mismatch'
        second = Client(context)
        clients.append(second)
        second.login(credentials.pop('loginName'), credentials.pop('password'))
        after = second.ok(base)
        report['after'] = {k: after.get(k) for k in ('id', 'state', 'generation', 'romProfileId', 'nodeId')}
        assert report['before'] == report['after'], 'phone_identity_changed'
        listed = second.ok(base + '/files?generation=' + str(generation))
        assert dict(name=name, sizeBytes=len(raw)) in listed['data'], 'phone_file_missing'
        exported = second.ok(base + '/file-exports', dict(expectedGeneration=generation, name=name))
        reference = second.ok('/api/v1/objects/' + exported['objectId'] + '/references',
                              dict(capability='virtual_phone', expires_in_seconds=60))
        with second.opener.open(ORIGIN + '/api/v1/objects/references/' + reference['reference_id'] + '/content', timeout=30) as response:
            received = response.read()
        assert received == raw and exported['sha256'] == digest, 'phone_download_mismatch'
        report['checks'] = dict(uploaded=True, independentLoginListed=True, independentLoginDownloaded=True,
                                bytes=len(raw), sha256=digest, filename=name, unchangedIdentityAndGeneration=True)
        report['status'] = 'passed'
    except Exception as error:
        value = str(error)
        report['errorCode'] = value if re.fullmatch(r'[a-z_]{3,100}', value) else 'bounded_probe_failed'
    finally:
        # Signing out an initiator identity would terminate its active cast.
        for client in clients:
            client.csrf = None
            client.opener.close()
        report['cleanup'] = dict(adminSignedOut=False, authSessionsExpireNormally=True,
                                 syntheticFileRetained=True, userFilesDeleted=False, guestLifecycleRequested=False)
        report['completedAt'] = now()
        with output.open('x') as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
        print(json.dumps(report), flush=True)
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
