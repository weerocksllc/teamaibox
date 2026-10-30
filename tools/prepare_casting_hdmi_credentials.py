#!/usr/bin/env python3
"""Derive a boot-local HDMI configuration; private identities never leave tmpfs."""
import argparse
import json
import os
from pathlib import Path
import stat
from casting_service_credentials import require_tmpfs

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,required=True,help='existing boot-local media credentials')
    parser.add_argument('--target',type=Path,required=True,help='new boot-local media credential directory')
    parser.add_argument('--card',type=int,required=True)
    parser.add_argument('--connector',required=True)
    parser.add_argument('--audio-card',type=int,required=True)
    parser.add_argument('--audio-device',type=int,required=True)
    args=parser.parse_args()
    if os.geteuid()!=0:raise RuntimeError('root_required')
    source_root,target_root=args.source,args.target
    credential_root=Path('/run/teamaibox/casting')
    if any(path.name!='media' or path.parent.parent!=credential_root for path in (source_root,target_root)):
        raise RuntimeError('boot_local_media_generation_required')
    if not source_root.is_absolute() or source_root.resolve(strict=True)!=source_root or not source_root.is_dir():
        raise RuntimeError('explicit_regular_source_directory_required')
    if not target_root.is_absolute() or target_root.resolve()!=target_root or target_root==source_root or source_root in target_root.parents or target_root in source_root.parents:
        raise RuntimeError('distinct_regular_target_directory_required')
    if min(args.card,args.audio_card,args.audio_device)<0 or not args.connector:
        raise RuntimeError('explicit_hardware_selection_required')
    require_tmpfs(source_root);require_tmpfs(target_root)
    target_root.mkdir(parents=True,mode=0o700,exist_ok=True)
    for source in source_root.iterdir():
        info=source.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode&0o007:raise RuntimeError('protected_input_invalid')
        raw=source.read_bytes()
        if source.name=='runtime.json':
            value=json.loads(raw)
            if value['hdmi'] is not None:raise RuntimeError('parent_config_changed')
            value['hdmi']=dict(card=args.card,connector=args.connector,audioCard=args.audio_card,audioDevice=args.audio_device,greeterHandoff=True)
            raw=json.dumps(value,separators=(',',':')).encode()
        target=target_root/source.name
        if target.exists():
            if target.is_symlink() or target.read_bytes()!=raw:raise RuntimeError('existing_identity_changed')
        else:
            with target.open('xb') as f:f.write(raw)
            target.chmod(0o400);os.chown(target,65532,65532)
    os.chown(target_root,65532,65532);target_root.chmod(0o700)
    target_root.parent.chmod(0o711)

if __name__=='__main__':main()
