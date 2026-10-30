#!/usr/bin/env bash
set -euo pipefail
INSTALL_SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 "$INSTALL_SOURCE/package.py" "$@"
