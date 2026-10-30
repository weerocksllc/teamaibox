#!/usr/bin/env python3
"""Read-only, account-redacted Google/identity diagnostics for one phone.

Run inside the appliance host through SSH. No registration, data clearing,
property overrides, package updates, UI input, or lifecycle operations.
"""
import argparse
import datetime
import hashlib
import json
import re
import subprocess


def run(args):
    p = subprocess.run(args, capture_output=True, text=True, timeout=35)
    return p.returncode, p.stdout


def diagnostic_logs(logs):
    """Bounded, deduplicated signals; the numbers are not a diagnosis."""
    wanted = re.compile(r'\bCheckin(?:Service|Task|Request|Response|ChimeraService)?\b|'
                        r'FATAL EXCEPTION|SERVICE_INVALID|/GmsCompliance\b|'
                        r'SSLHandshakeException|UnknownHostException', re.I)
    counts = {'checkinSuccess': 0, 'serviceInvalid': 0, 'fatalException': 0,
              'missingReadPhoneState': 0}
    selected = []
    seen = set()
    for line in logs.splitlines():
        # ADB logs its own requested command; that is not an app event.
        if '/adbd ' in line or not wanted.search(line):
            continue
        counts['checkinSuccess'] += int('Checkin Succeeded:' in line)
        counts['serviceInvalid'] += int('statusCode=SERVICE_INVALID' in line)
        counts['fatalException'] += int('FATAL EXCEPTION' in line)
        counts['missingReadPhoneState'] += int('Gms missing READ_PHONE_STATE' in line)
        line = re.sub(r'[\w.+-]+@[\w.-]+', '<account>', line)
        line = re.sub(r'https?://\S+', '<url>', line)
        line = re.sub(r'(?i)\b(token|auth|android_id|gsf_id|serial|deviceid|securitytoken)\s*[:=]\s*\S+', r'\1=<redacted>', line)
        line = re.sub(r'\b[0-9a-fA-F]{12,}\b|\b\d{10,}\b', '<identifier>', line)
        key = re.sub(r'\(\s*\d+\)', '(pid)', line)
        if key not in seen:
            seen.add(key)
            selected.append(line[:600])
    return {'signals': counts, 'uniqueSelectedLineCount': len(selected), 'lines': selected[-40:]}


def main(container):
    if not re.fullmatch(r'teamaibox-phone-[0-9a-f-]{36}', container):
        raise ValueError('invalid_phone_container')
    code, raw = run(['docker', 'inspect', container])
    if code:
        raise RuntimeError('phone_not_found')
    info = json.loads(raw)[0]
    if not info['State']['Running']:
        raise RuntimeError('phone_not_running')

    def adb(command):
        return run(['docker', 'exec', '-u', '10001', container,
                    '/opt/cuttlefish/bin/adb', 'shell', command])

    result = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'readOnly': True, 'containerId': info['Id'], 'image': info['Image'],
              'startedAt': info['State']['StartedAt']}
    _, config_raw = run(['docker', 'exec', '-u', '10001', container, 'cat', '/run/phone/config.json'])
    config = json.loads(config_raw)
    result['phone'] = {k: config[k] for k in ('phoneId', 'runId', 'generation', 'instance')}
    result['properties'] = {}
    for name in ('ro.build.fingerprint', 'ro.boot.verifiedbootstate', 'ro.boot.flash.locked',
                 'ro.com.google.gmsversion', 'ro.product.model', 'ro.product.manufacturer',
                 'sys.boot_completed', 'ro.serialno', 'ro.boot.serialno'):
        status, value = adb('getprop ' + name)
        value = value.strip()
        if 'serial' in name:
            value = {'present': bool(value), 'sha256': hashlib.sha256(value.encode()).hexdigest() if value else None}
        result['properties'][name] = {'exitCode': status, 'value': value}
    for field, cmd in [('provisioned', 'settings get global device_provisioned'),
                       ('setupComplete', 'settings get secure user_setup_complete'),
                       ('guestUtc', 'date -u +%Y-%m-%dT%H:%M:%SZ')]:
        result[field] = adb(cmd)[1].strip()
    accounts = adb('dumpsys account')[1]
    counts = re.findall(r'^\s*Accounts: (\d+)\s*$', accounts, re.M)
    result['accountCount'] = sum(map(int, counts)) if counts else None
    result['internetValidated'] = 'VALIDATED' in adb('dumpsys connectivity')[1]
    result['packages'] = {}
    for pkg in ('com.android.vending', 'com.google.android.gms', 'com.google.android.gsf', 'com.google.android.setupwizard'):
        status, dump = adb('dumpsys package ' + pkg)
        result['packages'][pkg] = {'exitCode': status,
            'versions': re.findall(r'\bversionName=([^\n]+)', dump),
            'lastUpdateTime': re.findall(r'\blastUpdateTime=([^\n]+)', dump),
            'installedUser0': bool(re.search(r'User 0:.*installed=true', dump)),
            'suspendedUser0': bool(re.search(r'User 0:.*suspended=true', dump))}
    activities = adb('dumpsys activity activities')[1]
    result['foreground'] = re.findall(r'topResumedActivity=.*? ([\w.]+/[\w.$]+)', activities)
    result['googleState'] = {}
    for pkg in ('com.google.android.gsf', 'com.google.android.gms'):
        query = "su 0 sqlite3 -readonly /data/user/0/" + pkg + "/databases/gservices.db \"select name,value from main where name in ('android_id','uncertified_status');\""
        status, rows = adb(query)
        values = dict(line.split('|', 1) for line in rows.strip().splitlines() if '|' in line)
        gsf = values.get('android_id', '')
        uncertified = values.get('uncertified_status', '')
        result['googleState'][pkg] = {'queryExitCode': status, 'gsfIdPresent': bool(gsf),
            'gsfIdSha256': hashlib.sha256(gsf.encode()).hexdigest() if gsf else None,
            'uncertifiedStatus': int(uncertified) if uncertified.isdecimal() else None}
    # Emit only bounded diagnostic lines. Never emit account names, IDs,
    # authorization strings, URLs with query values, or raw preference blobs.
    status, logs = adb('logcat -d -v brief -t 12000')
    result['logWindow'] = {'queryExitCode': status, **diagnostic_logs(logs)}
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('container')
    main(parser.parse_args().container)
