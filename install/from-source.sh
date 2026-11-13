#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if [[ ${1:-} == design ]]; then
    shift
    exec python3 install/source_design.py "$@"
fi
exec python3 install/source_install.py "$@"
