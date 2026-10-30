"""SQL transport restricted to the database created by this installation."""
import json
from pathlib import Path
import subprocess

from offline_common import need, read_json, run


def database_mount_owned(mounts, expected, inspect_volume):
    for mount in mounts:
        if mount.get('Destination') not in ('/var/lib/postgresql', '/var/lib/postgresql/data'):
            continue
        if mount.get('Type') == 'bind':
            return mount.get('Source') == expected
        if mount.get('Type') == 'volume' and mount.get('Name'):
            volume = inspect_volume(mount['Name'])
            return (volume.get('Driver') == 'local' and volume.get('Options') ==
                    dict(type='none', o='bind', device=expected))
    return False


def target(root):
    from appliance_installation import load, resolve
    state, record = read_json(root / 'install-state.json'), load(root / 'installation.json')
    need(state['installationId'] == record['installationId'] and state['nodeId'] == record['nodeId'],
         'database installation identity differs')
    database = resolve(record, 'postgres')
    need(database['Config']['Labels'].get('com.teamaibox.installation-id') == state['installationId']
         and database_mount_owned(database['Mounts'], str(root / 'data/database/postgres'),
             lambda name: json.loads(run(['docker', 'volume', 'inspect', name]))[0]),
         'database does not belong to this new installation')
    return database['Id']


def query(root, sql):
    result = subprocess.run(['docker', 'exec', '-i', target(root), 'psql', '-X', '-qAt',
        '-v', 'ON_ERROR_STOP=1', '-U', 'teamaibox', '-d', 'teamaibox'],
        input=sql, text=True, capture_output=True, timeout=120)
    # SQL and arbitrary PostgreSQL errors can contain source/customer values.
    need(result.returncode == 0, 'fresh database operation failed; existing rows were not overwritten')
    return result.stdout.strip()
