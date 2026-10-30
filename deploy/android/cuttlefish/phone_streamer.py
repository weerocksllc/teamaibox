#!/usr/bin/python3
"""Fixed wrapper for the one Cuttlefish streamer, not a command API.

Use Cuttlefish's existing restarter so media can be closed independently of
Android. Only this process reads the no-ADB config; the guest and the private
Node Agent APK/file/temporary-debug path keep their original configuration.
"""
import copy
import os
from pathlib import Path
import sys

sys.path.insert(0, '/opt/teamaibox')


def media_configuration(value, instance):
    if not isinstance(value, dict) or not isinstance(value.get('instances'), dict) or set(value['instances']) != {str(instance)}:
        raise ValueError('phone_streamer_configuration_invalid')
    result=copy.deepcopy(value)
    selected=result['instances'][str(instance)]
    if not isinstance(selected,dict) or not isinstance(selected.get('adb_ip_and_port'),str):
        raise ValueError('phone_streamer_configuration_invalid')
    # AdbHandler treats a string without ':' as no socket. Do not use port 0
    # or /dev/null (upstream's fallback can otherwise spin on readable EOF).
    selected['adb_ip_and_port']=''
    selected['adb_host_port']=0
    return result


def main():
    from phone_runtime import BASE, CONFIG, DATA, atomic_json, closed_json, validate_config
    declaration=validate_config(closed_json(CONFIG.read_bytes()))
    source=DATA/'cuttlefish/assembly/cuttlefish_config.json'
    if os.environ.get('CUTTLEFISH_CONFIG_FILE')!=str(source) or source.is_symlink() or source.stat().st_size>4*1024**2:
        raise ValueError('phone_streamer_configuration_invalid')
    media_config=media_configuration(closed_json(source.read_bytes()),declaration['instance'])
    destination=DATA/'.media-config.json'
    if destination.is_symlink():raise ValueError('phone_streamer_configuration_invalid')
    atomic_json(destination,media_config)
    environment=dict(os.environ,CUTTLEFISH_CONFIG_FILE=str(destination))
    restarter=str(BASE/'bin/process_restarter')
    os.execve(restarter,[restarter,'--when_killed','--when_dumped','--',str(BASE/'bin/webRTC.elf'),*sys.argv[1:]],environment)


if __name__=='__main__':main()
