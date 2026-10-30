#!/usr/bin/env python3
"""Validate the isolated encrypted transport only, never Android acceptance."""
import argparse
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / 'evidence/validation/virtual-phones'
BUILD = DIRECTORY / 'phone-camera-browser-build-20260914-a2.json'
BUILD_SHA = '665d943ae05279812d3cf61ad64ad48b11c404c8d2da75fa16708fea5a937290'
SOURCES = {'tools/test_phone_browser_camera_transport.mjs', 'tools/phone_browser_camera_probe.py',
           'apps/virtual-phones-plugin/src/public/phone-browser-capture.mjs',
           'deploy/android/cuttlefish/phone_browser_camera.py'}
sha = lambda value: hashlib.sha256(value).hexdigest()


def require(value, code):
    if not value:
        raise RuntimeError(code)


def validate(path, current_sources=True):
    r = json.loads(path.read_bytes())
    require(re.fullmatch(r'phone-camera-browser-transport-\d{8}-a[1-9]\d*', r['runId']), 'run_invalid')
    require(path.resolve() == DIRECTORY / (r['runId']+'.json'), 'path_invalid')
    require(r['status'] == 'passed' and r['failure'] is None, 'transport_failed')
    require(r['syntheticOnly'] is True and all(r[k] is False for k in ('androidStarted','memberEnabled','physicalCapture')), 'scope_invalid')
    require(sha(BUILD.read_bytes()) == BUILD_SHA, 'parent_changed')
    build = json.loads(BUILD.read_bytes())
    require(build['status'] == 'passed' and build['imageId'] == r['imageId'], 'image_unbound')
    require(build['nodeBefore'] == build['nodeAfter'] and build['mainBefore'] == build['mainAfter'], 'build_office_changed')
    require(set(r['sources']) == SOURCES | ({'apps/platform-api/src/virtual-phones/phone-browser-camera-sdp.mjs'} if r.get('natPeerNormalization') else set()), 'sources_missing')
    if r.get('natPeerNormalization'):require(r.get('originalHostDiffered') is True,'nat_not_exercised')
    require(r['sources']['deploy/android/cuttlefish/phone_browser_camera.py'] == build['sources']['deploy/android/cuttlefish/phone_browser_camera.py'], 'built_source_changed')
    for file, digest in r['sources'].items():
        require(re.fullmatch('[a-f0-9]{64}', digest), 'source_digest_invalid')
        if current_sources:
            require(sha((ROOT/file).read_bytes()) == digest, 'source_changed:'+file)
    require(r['before'] == r['after'] and r['before']['main'] and r['before']['node'], 'office_changed')
    require(r['containerRemoved'] is True and r['containerExit'] == {'running':False,'code':0,'oomKilled':False}, 'cleanup_failed')
    active, stopped = r['active'], r['stopped']
    require(active['errors'] == [] and active['status']['state'] == 'receiving' and active['status']['framesDelivered'] >= 45, 'frames_missing')
    samples = active['samples']
    require(len(samples) >= 8 and all((s['width'], s['height']) == (640,480) and len(s['points']) == 4 for s in samples), 'format_invalid')
    require(all(b['at'] > a['at'] and b['sequence'] > a['sequence'] for a,b in zip(samples,samples[1:])), 'sequence_invalid')
    require(any(s['points'][0] < 30 and s['points'][1] > 225 for s in samples) and any(s['points'][0] > 225 and s['points'][1] < 30 for s in samples), 'motion_missing')
    browser = r['browser']
    require(browser['audioTracks'] == 0 and len(browser['outbound']) == 1 and browser['outbound'][0]['kind'] == 'video' and browser['outbound'][0]['framesEncoded'] >= 45, 'video_only_failed')
    require(any(t['dtlsState'] == 'connected' and t['srtpCipher'] in ('SRTP_AES128_CM_HMAC_SHA1_80','SRTP_AEAD_AES_128_GCM','SRTP_AEAD_AES_256_GCM') for t in browser['transports']), 'encryption_missing')
    require(stopped['receiverClosed'] is True and stopped['after']['state'] == 'stopped' and stopped['after']['retainedFrameBytes'] == 0, 'private_frame_retained')
    require(r['browserStopped'] == {'state':'off','stream':None,'peer':'closed','revoked':1}, 'capture_not_stopped')
    for memory in (active['memory'], stopped['before']['memory']):
        require(0 < memory['memory.peak'] <= 512*1024**2 and memory['memory.swap.current'] == 0 and memory['events']['oom'] == 0 and memory['events']['oom_kill'] == 0, 'resource_failed')
    return {'valid':True,'runId':r['runId'],'evidenceSha256':sha(path.read_bytes()),'syntheticOnly':True,'androidAccepted':False,'task10_4Complete':False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence', type=Path, required=True)
    print(json.dumps(validate(parser.parse_args().evidence)))
