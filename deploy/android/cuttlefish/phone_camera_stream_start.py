#!/usr/bin/python3
"""Isolated candidate: select the existing V4L2 guest HAL, retain network policy."""
import phone_network_base as network

original_arguments = network.network_launch_arguments


def camera_arguments(config):
    return original_arguments(config) + [
        '--camera=type=v4l2_emulated',
        '--crosvm_binary=/opt/teamaibox/phone_camera_crosvm.py',
    ]


network.network_launch_arguments = camera_arguments
if __name__ == '__main__':
    raise SystemExit(network.start())
