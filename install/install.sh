#!/usr/bin/env bash
set -euo pipefail
INSTALL_PACKAGE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 -B "$INSTALL_PACKAGE/installer.py" --package "$INSTALL_PACKAGE" "$@"
