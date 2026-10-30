#!/usr/bin/env python3
"""Install media address maintenance using verified local installation paths."""
import argparse
import json
import os
from pathlib import Path
from appliance_installation import load, resolve, host_path, save
from appliance_network_identity import atomic_write
from appliance_phone_media import reconcile


def main():
    p = argparse.ArgumentParser(); p.add_argument('--installation', required=True); p.add_argument('--network-configuration', required=True); p.add_argument('--patch-output', required=True)
    args = p.parse_args()
    if os.geteuid() != 0: raise PermissionError('root_required')
    installation = load(args.installation); agent = resolve(installation, 'node-agent')
    path = Path(installation['references']['phones']); phones = json.loads(path.read_text())
    if phones['nodeId'] != installation['nodeId']: raise ValueError('phone_installation_identity_mismatch')
    env = dict(v.split('=', 1) for v in agent['Config']['Env'])
    target = str(Path(env['TEAMAIBOX_PHONES_CONFIG_FILE']).parent / 'phone-media-state.json')
    state = host_path(agent, target)
    config_path = Path(args.network_configuration)
    config = json.loads(config_path.read_text())
    config.update(installationFile=str(Path(args.installation).resolve()), phoneMedia={
        **{k: phones[k] for k in ('nodeId', 'poolId', 'controlRoot', 'controlNetworkId')}, 'stateFile': state})
    atomic_write(config_path, (json.dumps(config, indent=2)+'\n').encode(), 0o600)
    if not Path(state).exists():
        atomic_write(state, (json.dumps(dict(version=1,nodeId=phones['nodeId'],poolId=phones['poolId'],status='preparing',updatedAt=0,runs={}))+'\n').encode(), 0o644)
    atomic_write(args.patch_output, (json.dumps({'phones':{'hostMediaStateFile':target}})+'\n').encode(), 0o600)
    installation['references']['networkIdentity'] = str(config_path.resolve()); save(args.installation, installation)
    print(json.dumps({'status':'prepared','mediaStateReference':target}))


if __name__ == '__main__': main()
