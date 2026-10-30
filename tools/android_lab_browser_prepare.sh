#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends chromium socat
chromium --version
dpkg-query -W -f='${Package} ${Version}\n'
