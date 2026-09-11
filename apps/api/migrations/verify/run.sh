#!/usr/bin/env bash
# Applies every migration to a throwaway database, checks the constraints refuse what they must,
# exercises the leases, the transactional replacement and the retention rules, then rolls everything
# back and applies it again.
#
#   createdb huddle_verify
#   DATABASE_URL=postgres://localhost/huddle_verify migrations/verify/run.sh
#
# It writes to the database it is pointed at. Never point it at one with data in it.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL to a throwaway database}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
migrations="$(dirname "$here")"
psql() { command psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q "$@"; }

apply() { for file in "$migrations"/*.up.sql; do psql -f "$file" >/dev/null; done; }
rollback() { for file in $(ls -r "$migrations"/*.down.sql); do psql -f "$file" >/dev/null; done; }

echo "applying $(ls "$migrations"/*.up.sql | wc -l | tr -d ' ') migrations"
apply
psql -tAc "SELECT string_agg(version, ' ' ORDER BY version) FROM schema_migrations"

echo "loading the dataset"
psql -f "$here/01_dataset.sql" >/dev/null

echo "checking refusals"
expected=$(grep -c '^\\echo' "$here/02_refusals.sql")
# ON_ERROR_STOP is off inside the refusals fixture: every statement is meant to fail.
actual=$(command psql "$DATABASE_URL" -q -f "$here/02_refusals.sql" 2>&1 | grep -cE '^psql.*ERROR' || true)
if [ "$actual" != "$expected" ]; then
  echo "expected $expected refusals, got $actual — a constraint accepted something it must not" >&2
  exit 1
fi
echo "$actual/$expected refused"

echo "checking behaviour"
psql -f "$here/03_behaviour.sql"

echo "rolling back"
rollback
remaining=$(psql -tAc "SELECT coalesce(string_agg(tablename, ','), 'none') FROM pg_tables WHERE schemaname = 'public'")
# The ledger itself survives a full rollback by design; anything else means a down file missed a table.
if [ "$remaining" != "schema_migrations" ]; then
  echo "rollback left $remaining behind" >&2
  exit 1
fi

echo "re-applying"
apply
psql -tAc "SELECT count(*) || ' migrations, ' || (SELECT count(*) FROM pg_tables WHERE schemaname = 'public') || ' tables' FROM schema_migrations"
echo "ok"
