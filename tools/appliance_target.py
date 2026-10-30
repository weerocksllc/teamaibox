"""Explicit maintenance targets. Importing this module never opens a connection."""
import os
import re


def ssh_target(value=None):
    target = value or os.environ.get('TEAMAIBOX_APPLIANCE_SSH')
    if not target or not re.fullmatch(r'[A-Za-z0-9_.-]+@[A-Za-z0-9_.:-]+', target):
        raise ValueError('explicit_TEAMAIBOX_APPLIANCE_SSH_required')
    return target


def postgres_target():
    first = os.environ.get('TEAMAIBOX_APPLIANCE_POSTGRES_CONTAINER')
    second = os.environ.get('TEAMAIBOX_POSTGRES_CONTAINER')
    if first and second and first != second:
        raise ValueError('conflicting_postgres_targets')
    value = first or second
    if not value or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', value):
        raise ValueError('explicit_TEAMAIBOX_POSTGRES_CONTAINER_required')
    return value
