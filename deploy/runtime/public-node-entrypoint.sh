#!/bin/sh
set -eu
exec node "${TEAMAIBOX_NODE_ENTRYPOINT:?build must select the service entry point}" "$@"
