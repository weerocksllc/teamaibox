#!/usr/bin/python3
"""Unpublished browser-camera runtime; split the existing 50-port phone range."""
import phone_network_base as network
from phone_network import recipe

original_arguments=network.network_launch_arguments

def camera_arguments(config):
    ports=recipe(config['instance']);args=original_arguments(config)
    # No additional host ports or firewall changes. Cuttlefish control/viewing
    # owns the first forty; the isolated browser camera owns the last ten.
    old=f"{ports['mediaFirst']}:{ports['mediaLast']}"
    new=f"{ports['mediaFirst']}:{ports['mediaLast']-10}"
    for kind in ('tcp','udp'):
        flag='--'+kind+'_port_range='
        if args.count(flag+old)!=1:raise network.PhoneError('phone_camera_port_range_invalid')
        args[args.index(flag+old)]=flag+new
    return args+['--camera=type=v4l2_emulated','--crosvm_binary=/opt/teamaibox/phone_camera_crosvm.py']

network.network_launch_arguments=camera_arguments
try:
    from phone_google_recovery import install
except ModuleNotFoundError as error:
    if error.name != 'phone_google_recovery': raise
else:
    install(network)
if __name__=='__main__':raise SystemExit(network.start())
