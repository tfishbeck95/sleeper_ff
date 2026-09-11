#!/usr/bin/env bash
# Applies the migrations this database has not got yet, in order.
#
#   DATABASE_URL=postgres://huddle@db/huddle migrations/apply.sh            # apply everything pending
#   DATABASE_URL=... migrations/apply.sh --dry-run                          # say what would be applied
#   DATABASE_URL=... migrations/apply.sh --to 0005                          # stop after 0005
#   DATABASE_URL=... migrations/apply.sh --status                           # what is applied, what is pending
#
# `schema_migrations` is the truth about what has been applied — every up file inserts its version and
# every down file deletes it — so this asks the database rather than trusting a deployment log or a
# file listing. Applying an already-applied version is not idempotent in general (a migration that
# backfills would run twice), so the ledger is what makes a re-run safe: pending means pending.
#
# Each file opens its own transaction, so a failure leaves the database exactly as it was, and the
# versions before it stay applied and recorded. The run does not resume automatically; fix the file and
# run this again, and it picks up from the version that failed.
#
# It runs as one psql session holding an advisory lock, so two deployment runners that start at the
# same time do not both apply 0007. The second waits for the first, then finds nothing pending.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL to the database to migrate}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# A constant rather than a hash of a name, so it is the same number on every PostgreSQL version.
LOCK_KEY=778811223344
LOCK_TIMEOUT="${MIGRATIONS_LOCK_TIMEOUT:-120s}"

mode=apply
target=

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) mode=dry-run; shift ;;
    --status) mode=status; shift ;;
    --to) target="${2:?--to needs a version, such as 0005}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

query() { psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAc "$1"; }

# On a database with no ledger yet — a fresh one, or one rolled all the way back before 0001 created it
# — this has to answer "nothing", not fail.
applied_versions() {
  # Two statements rather than one guarded by a CASE: PostgreSQL parses the whole statement before it
  # evaluates any of it, so a subquery over a table that does not exist yet fails whatever guards it.
  if [ "$(query "SELECT to_regclass('public.schema_migrations') IS NOT NULL")" != "t" ]; then echo ""; return; fi
  query "SELECT coalesce(string_agg(version, ' ' ORDER BY version), '') FROM schema_migrations"
}

applied=" $(applied_versions) "
pending=()
for file in "$here"/[0-9][0-9][0-9][0-9]_*.up.sql; do
  version="$(basename "$file" | cut -d_ -f1)"
  case "$applied" in *" $version "*) continue ;; esac
  if [ -n "$target" ] && [ "$version" \> "$target" ]; then continue; fi
  pending+=("$file")
done

if [ "$mode" = status ]; then
  echo "applied: ${applied:-none}"
  if [ ${#pending[@]} -eq 0 ]; then echo "pending: none"; else
    echo "pending:"
    for file in "${pending[@]}"; do echo "  $(basename "$file" .up.sql)"; done
  fi
  exit 0
fi

if [ ${#pending[@]} -eq 0 ]; then
  echo "up to date: nothing to apply"
  exit 0
fi

echo "pending (${#pending[@]}):"
for file in "${pending[@]}"; do echo "  $(basename "$file" .up.sql)"; done

if [ "$mode" = dry-run ]; then
  echo "dry run: nothing was applied"
  exit 0
fi

# One session for the whole run: the advisory lock is session-scoped, so it is held across every file
# and released when psql exits, however it exits.
{
  echo "SET lock_timeout = '$LOCK_TIMEOUT';"
  echo "SELECT pg_advisory_lock($LOCK_KEY);"
  for file in "${pending[@]}"; do
    echo "\\echo applying $(basename "$file" .up.sql)"
    echo "\\i $file"
  done
} | psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f -

echo "applied: $(applied_versions)"
