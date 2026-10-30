"""Initialize admin/admin only in an empty, installation-owned identity store."""
import json
from pathlib import Path
import secrets
import subprocess

from offline_common import need, read_json, write_json


def apply(root, check=False):
    from appliance_installation import load, resolve
    from factory_database import query
    # query verifies the database's installation ID and physical data mount.
    present = query(root, 'SELECT count(*) FROM iam.appliance_bootstrap;')
    if present == '1':
        return dict(status='preserved', usersCreated=0)
    need(present == '0', 'unexpected owner bootstrap state; existing accounts preserved')
    need(not check, 'default administrator has not been initialized')
    need(query(root, 'SELECT count(*) FROM iam.identities;') == '0',
         'existing identities without owner record; accounts preserved')
    record = load(root / 'installation.json')
    state = read_json(root / 'install-state.json')
    need(state['installationId'] == record['installationId'], 'owner installation identity differs')
    api = resolve(record, 'platform-api')
    need(api['Config']['Labels'].get('com.teamaibox.installation-id') == record['installationId'],
         'owner API does not belong to this installation')
    path = root / 'secrets/initial-owner-recovery.json'
    if not path.exists():
        write_json(path, dict(installationId=record['installationId'],
                             recoveryCodes=['taib-recovery-' + secrets.token_urlsafe(24) for _ in range(8)]))
    need(not path.is_symlink() and path.stat().st_mode & 0o077 == 0,
         'initial owner recovery file permissions invalid')
    codes = read_json(path)
    need(codes['installationId'] == record['installationId'], 'owner recovery belongs to another installation')
    source = (root / 'runtime/install/factory_owner.mjs').read_text()
    source += "\nlet raw='';for await(const part of process.stdin)raw+=part;console.log(JSON.stringify(await main(JSON.parse(raw))));\n"
    result = subprocess.run(['docker', 'exec', '-i', '--workdir', '/opt/teamaibox', api['Id'],
                             'node', '--input-type=module', '-e', source],
                            input=json.dumps(dict(recoveryCodes=codes['recoveryCodes'])),
                            capture_output=True, text=True, timeout=60)
    need(result.returncode == 0, 'default administrator initialization failed; existing accounts were not reset')
    report = json.loads(result.stdout)
    write_json(root / 'initial-owner.json', dict(installationId=record['installationId'], **report))
    return report
