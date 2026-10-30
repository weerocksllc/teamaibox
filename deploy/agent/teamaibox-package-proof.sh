#!/bin/sh
set -eu

mode="${1:-}"
case "$mode" in
  online|offline) ;;
  *) echo "usage: teamaibox-package-proof online|offline" >&2; exit 64 ;;
esac

root="/workspace/.teamaibox/package-proof/$mode"
proof="/workspace/package-proof-$mode.json"
test "${PIP_INDEX_URL:-}" = "http://source-gateway:8080/pip/simple/"
test "${NPM_CONFIG_REGISTRY:-}" = "http://source-gateway:8080/npm/registry/"
test "${TEAMAIBOX_APT_PROXY_URL:-}" = "http://source-gateway:8080/apt"
test "${PIP_CONFIG_FILE:-}" = "/run/teamaibox/source-config/pip.conf"
test "${NPM_CONFIG_USERCONFIG:-}" = "/run/teamaibox/source-config/npmrc"
test "${APT_CONFIG:-}" = "/run/teamaibox/source-config/apt/apt.conf"

rm -rf -- "$root"
rm -f -- "$proof"
mkdir -p "$root/python" "$root/npm-cache" "$root/npm" \
  "$root/apt/state/lists/partial" "$root/apt/cache/archives/partial" \
  "$root/apt/download" "$root/apt/root"

python3 -m pip install \
  --disable-pip-version-check --no-cache-dir --no-deps \
  --target "$root/python" "six==1.17.0"
PYTHONPATH="$root/python" python3 -c 'import six; assert six.__version__ == "1.17.0"'

npm install \
  --ignore-scripts --no-audit --no-fund \
  --cache "$root/npm-cache" --prefix "$root/npm" \
  "is-number@7.0.0"
node -e 'const value=require(process.argv[1]);if(value("12")!==true||value("x")!==false)process.exit(1)' \
  "$root/npm/node_modules/is-number"

apt-get -c "$APT_CONFIG" \
  -o "Dir::State=$root/apt/state" \
  -o "Dir::State::status=/var/lib/dpkg/status" \
  -o "Dir::Cache=$root/apt/cache" \
  -o "Dir::Cache::archives=$root/apt/cache/archives" \
  update
(
  cd "$root/apt/download"
  apt-get -c "$APT_CONFIG" \
    -o "Dir::State=$root/apt/state" \
    -o "Dir::State::status=/var/lib/dpkg/status" \
    -o "Dir::Cache=$root/apt/cache" \
    -o "Dir::Cache::archives=$root/apt/cache/archives" \
    download hello
)
deb="$(find "$root/apt/download" -maxdepth 1 -type f -name 'hello_*_arm64.deb' -print -quit)"
test -n "$deb"
dpkg-deb -x "$deb" "$root/apt/root"
"$root/apt/root/usr/bin/hello" | grep -q "Hello, world!"

node - "$mode" "$proof" <<'NODE'
const [mode, proof] = process.argv.slice(2);
const response = await fetch("http://source-gateway:8080/health/ready");
if (!response.ok) process.exit(1);
const health = await response.json();
for (const ecosystem of ["pip", "npm", "apt"]) {
  if (!Number.isSafeInteger(health?.stats?.[ecosystem]?.requests) || health.stats[ecosystem].requests < 1) process.exit(1);
}
const value = {
  schemaVersion: 1,
  status: "passed",
  mode,
  clients: {
    pip: { package: "six", version: "1.17.0", importVerified: true },
    npm: { package: "is-number", version: "7.0.0", requireVerified: true },
    apt: { package: "hello", architecture: "arm64", extractedBinaryVerified: true },
  },
  gateways: {
    pip: "http://source-gateway:8080/pip/simple/",
    npm: "http://source-gateway:8080/npm/registry/",
    apt: "http://source-gateway:8080/apt",
  },
  cacheCounters: Object.fromEntries(Object.entries(health.stats).map(([key, item]) => [key, {
    cacheHits: item.cacheHits,
    upstreamFetches: item.upstreamFetches,
  }])),
  hostModified: false,
  directRepositoryCredentialReceived: false,
};
await import("node:fs/promises").then(({ writeFile }) => writeFile(proof, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 }));
NODE

printf '%s\n' '{"schemaVersion":1,"status":"passed","credentialsRetained":false,"packageOutputRetained":false}'
