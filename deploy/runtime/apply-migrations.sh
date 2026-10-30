#!/bin/bash
set -euo pipefail

password_file=${PLATFORM_DATABASE_PASSWORD_FILE:?PLATFORM_DATABASE_PASSWORD_FILE is required}
database_host=${PLATFORM_DATABASE_HOST:?PLATFORM_DATABASE_HOST is required}
database_port=${PLATFORM_DATABASE_PORT:-5432}
database_name=${PLATFORM_DATABASE_NAME:-teamaibox}
database_user=${PLATFORM_DATABASE_USER:-teamaibox}
migration_root=/opt/teamaibox/migrations
manifest_file=$migration_root/manifest.json
expected_manifest_checksum=${TEAMAIBOX_MIGRATION_MANIFEST_SHA256:?TEAMAIBOX_MIGRATION_MANIFEST_SHA256 is required}

if [[ ! "$expected_manifest_checksum" =~ ^[0-9a-f]{64}$ ]] \
    || [[ "$(sha256sum "$manifest_file" | cut -d ' ' -f 1)" != "$expected_manifest_checksum" ]]; then
  echo "Migration manifest checksum is invalid" >&2
  exit 1
fi

if [[ ! -r "$password_file" ]]; then
  echo "PostgreSQL password file is not readable" >&2
  exit 1
fi
IFS= read -r PGPASSWORD < "$password_file" || true
if (( ${#PGPASSWORD} < 16 || ${#PGPASSWORD} > 512 )) || [[ "$PGPASSWORD" == *$'\n'* || "$PGPASSWORD" == *$'\r'* ]]; then
  echo "PostgreSQL password file is invalid" >&2
  exit 1
fi
export PGPASSWORD
trap 'unset PGPASSWORD' EXIT INT TERM

psql_base=(
  psql
  --host "$database_host"
  --port "$database_port"
  --username "$database_user"
  --dbname "$database_name"
  --no-psqlrc
  --set ON_ERROR_STOP=1
  --no-align
  --tuples-only
  --quiet
)

ledger_exists=$("${psql_base[@]}" --command "SELECT to_regclass('public.teamaibox_schema_migrations') IS NOT NULL;")
applied=0
verified=0
for migration_file in "$migration_root"/[0-9][0-9][0-9][0-9][0-9][0-9]_*.up.sql; do
  filename=${migration_file##*/}
  if [[ ! "$filename" =~ ^([0-9]{6})_([a-z][a-z0-9_]{2,63})\.up\.sql$ ]]; then
    echo "Migration filename is invalid" >&2
    exit 1
  fi
  version_text=${BASH_REMATCH[1]}
  version=$((10#$version_text))
  name=${BASH_REMATCH[2]}
  checksum=$(sha256sum "$migration_file" | cut -d ' ' -f 1)
  expected_checksum=$(awk -v target="\"up\": \"$filename\"" '
    index($0, target) { found = 1; next }
    found && /"upSha256":/ {
      value = $0
      sub(/^.*"upSha256":[[:space:]]*"/, "", value)
      sub(/".*$/, "", value)
      print value
      exit
    }
  ' "$manifest_file")
  if [[ ! "$checksum" =~ ^[0-9a-f]{64}$ || "$checksum" != "$expected_checksum" ]]; then
    echo "Migration source checksum differs from the release manifest at version $version" >&2
    exit 1
  fi
  if grep -Eq '^[[:space:]]*\\' "$migration_file"; then
    echo "Migration contains a forbidden psql meta-command at version $version" >&2
    exit 1
  fi

  existing=""
  if [[ "$ledger_exists" == "t" ]]; then
    existing=$("${psql_base[@]}" --command "SELECT sha256 FROM public.teamaibox_schema_migrations WHERE version = $version;")
  fi
  if [[ -n "$existing" ]]; then
    if [[ "$existing" != "$checksum" ]]; then
      echo "Applied migration checksum differs from the release at version $version" >&2
      exit 1
    fi
    ((verified += 1))
    continue
  fi

  {
    echo "BEGIN;"
    echo "SELECT pg_advisory_xact_lock(8244704666841902962);"
    echo "SET LOCAL lock_timeout = '10s';"
    echo "SET LOCAL statement_timeout = '120s';"
    sed -n 'p' "$migration_file"
    printf "INSERT INTO public.teamaibox_schema_migrations (version, name, sha256, execution_milliseconds) VALUES (%d, '%s', '%s', 0);\n" "$version" "$name" "$checksum"
    echo "COMMIT;"
  } | "${psql_base[@]}"
  ledger_exists=t
  ((applied += 1))
done

expected=$(grep -c '"up":' "$manifest_file")
actual=$("${psql_base[@]}" --command "SELECT count(*) FROM public.teamaibox_schema_migrations;")
maximum=$("${psql_base[@]}" --command "SELECT COALESCE(max(version), 0) FROM public.teamaibox_schema_migrations;")
if [[ "$actual" != "$expected" || "$maximum" != "$expected" ]]; then
  echo "PostgreSQL migration ledger is incomplete" >&2
  exit 1
fi
printf '{"applied":%d,"verified":%d,"schemaVersion":%d}\n' "$applied" "$verified" "$maximum"
