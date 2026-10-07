#!/usr/bin/env sh
# Creates a scratch database, applies every migration in order, runs every
# test file, then drops the database. Connection settings come from the
# standard libpq variables (PGHOST, PGPORT, PGUSER, ...). The user needs
# CREATEDB and permission to create roles (migration 002 creates picksched_app).
# Exits non-zero on the first failure.
set -eu
cd "$(dirname "$0")"
DB="picksched_test_$$"
createdb "$DB"
trap 'dropdb --if-exists "$DB"' EXIT
for f in migrations/*.sql; do
    psql -q -X -v ON_ERROR_STOP=1 -d "$DB" -f "$f" >/dev/null
done
for f in tests/*.sql; do
    echo "== $f"
    if ! out=$(psql -X -v ON_ERROR_STOP=1 -d "$DB" -f "$f" 2>&1); then
        printf '%s\n' "$out" | sed 's/^psql:[^ ]* //' | grep -E 'PASS|FAIL|ERROR|CONTEXT'
        exit 1
    fi
    printf '%s\n' "$out" | sed -n 's/.*NOTICE:  //p; /passed/p'
done
