#!/bin/sh
set -eu

umask 077
mkdir -p /workspace/.teamaibox/home /workspace/.teamaibox/data \
  /workspace/.teamaibox/cache /workspace/.teamaibox/config/opencode \
  /workspace/.teamaibox/state

password_file=/run/teamaibox/secrets/opencode-password
test -f "$password_file"
password=$(cat "$password_file")
test "${#password}" -ge 32
export OPENCODE_SERVER_PASSWORD=$password
unset password password_file

exec /opt/opencode/opencode "$@"
