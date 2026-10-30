"""Local-only argument validation for explicitly selected maintenance builds."""
import argparse
from pathlib import PurePosixPath
import re


def staging_root(value):
    if not isinstance(value, str) or not re.fullmatch(r'/[A-Za-z0-9_./-]+', value):
        raise argparse.ArgumentTypeError('staging root must be an explicit absolute POSIX path')
    path = PurePosixPath(value)
    if str(path) != value or '..' in path.parts or len(path.parts) < 3:
        raise argparse.ArgumentTypeError('staging root must name a dedicated directory')
    return value


def staging_directory(root, name):
    staging_root(root)
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,127}', name):
        raise ValueError('invalid_staging_run_name')
    return str(PurePosixPath(root) / name)


def container_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value):
        raise argparse.ArgumentTypeError('an explicit full Docker container ID is required')
    return value


def image_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', value):
        raise argparse.ArgumentTypeError('an explicit Docker image content ID is required')
    return value
