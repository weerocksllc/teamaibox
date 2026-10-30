#!/usr/bin/env python3
"""Fresh factory metadata, default owner and stopped runtime registration."""
import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from offline_common import need, read_json


def apply(root, check=False):
    from factory_database import query
    from factory_guest_catalog import apply as guests
    from factory_office_catalog import statements
    from factory_workers import apply as workers
    from factory_applications import apply as applications
    from factory_owner import apply as owner
    runtime = read_json(root / 'config/office-runtime.json')
    query(root, statements(runtime, runtime['documents'], check))
    guests(root, check)
    workers(root, check)
    applications(root, check)
    administrator = owner(root, check)
    return dict(status='checked' if check else 'registered', usersCreated=administrator['usersCreated'],
                guestsCreated=0, officeWorkersStarted=False)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--installation-root', type=Path, required=True)
    p.add_argument('--check', action='store_true')
    args = p.parse_args()
    need(os.geteuid() == 0, 'root required')
    print(json.dumps(apply(args.installation_root.resolve(), args.check)))
