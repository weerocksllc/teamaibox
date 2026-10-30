#!/bin/sh
set -eu

password_file=/run/teamaibox/secrets/opencode-password
test -f "$password_file"
password=$(cat "$password_file")
test "${#password}" -ge 32
export OPENCODE_SERVER_PASSWORD=$password
unset password password_file

exec /opt/opencode/opencode "$@"
