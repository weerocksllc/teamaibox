#!/usr/bin/env python3
"""Publication supplement: paths and live host inventories, not only secrets.

Does not print matching credential content. Run scan_secrets.py and a history
secret scanner as well; these structural checks are not a proof of no leaks.
"""
import ipaddress
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
IP = re.compile(r'(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d|\.\d)')


def inspect(path, content):
    findings = []
    if path.split('/')[0] == 'website':
        findings.append('private-website-directory')
    for match in IP.finditer(path):
        try:
            address = ipaddress.ip_address(match.group())
        except ValueError:
            continue
        if any(address in ipaddress.ip_network(network) for network in
               ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')):
            findings.append('private-network-address-in-filename')
    if path.endswith('.json'):
        try:
            value = json.loads(content)
        except (ValueError, UnicodeDecodeError):
            value = None
        if isinstance(value, dict) and set(value) == {'retired', 'ordered'}:
            for entries in value.values():
                if isinstance(entries, list) and any(isinstance(row, dict) and
                        re.fullmatch('[a-f0-9]{64}', str(row.get('id', ''))) and
                        len(set(str(row['id']))) > 4 for row in entries):
                    findings.append('persisted-container-inventory')
                    break
    return findings


def main():
    names = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT)
    findings = []
    for name in sorted(set(names.decode().split('\0')) - {''}):
        path = ROOT / name
        if path.is_file() and not path.is_symlink():
            findings.extend(dict(path=name, rule=rule) for rule in inspect(name, path.read_bytes()))
    print(json.dumps(dict(findings=findings, clean=not findings), indent=2))
    return bool(findings)


if __name__ == '__main__':
    raise SystemExit(main())
