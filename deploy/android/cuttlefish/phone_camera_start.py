#!/usr/bin/python3
"""Camera-capable candidate only; the original runtime and phone disks stay pinned.

This enables the standard guest camera transport, not a physical source. The
candidate is not installed in the product allowlist before guest validation.
"""
import phone_network_base as network

original_arguments=network.network_launch_arguments
def camera_arguments(config):
    return original_arguments(config)+['--camera_server_port=7600']

network.network_launch_arguments=camera_arguments
if __name__=='__main__':raise SystemExit(network.start())
