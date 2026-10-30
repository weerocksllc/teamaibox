#!/usr/bin/env python3
"""One-time import of an already installed, root-owned volume declaration."""
import argparse
import ast
import json
import os
from pathlib import Path
from appliance_network_identity import atomic_write
from restore_existing_business_volumes import secure_path, validate_volumes, restore
from appliance_installation import load, save


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--legacy-adapter',required=True);parser.add_argument('--output',required=True)
    parser.add_argument('--installation',required=True);parser.add_argument('--check',action='store_true')
    args=parser.parse_args()
    if os.geteuid()!=0:raise PermissionError('root_required')
    secure_path(args.legacy_adapter)
    tree=ast.parse(Path(args.legacy_adapter).read_text())
    values=[ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='VOLUMES' for t in n.targets)]
    if len(values)!=1:raise ValueError('legacy_volume_declaration_ambiguous')
    config={'version':1,'volumes':list(values[0])}
    for volume in validate_volumes(config):restore(volume,check_only=True)
    path=Path(args.output)
    if path.exists() and json.loads(path.read_text())!=config:raise ValueError('existing_storage_configuration_differs')
    if not args.check:
        atomic_write(path,(json.dumps(config,indent=2)+'\n').encode(),0o600)
        record=load(args.installation);record['references']['storageVolumes']=str(path.resolve());save(args.installation,record)
    print(json.dumps({'status':'checked' if args.check else 'imported','volumes':len(config['volumes']),'keysChanged':False,'dataChanged':False}))


if __name__=='__main__':main()
