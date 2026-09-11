#!/usr/bin/env bash
# Rolls applied migrations back, newest first, down to a version you name.
#
#   DATABASE_URL=... migrations/rollback.sh --to 0006          # show what rolling back to 0006 would do
#   DATABASE_URL=... migrations/rollback.sh --to 0006 --yes    # actually do it
#   DATABASE_URL=... migrations/rollback.sh --one --yes        # roll back the newest applied version
#
# **A down migration is a schema operation, not an undo.** It drops what its up file created, and the
# rows in it go with it — nothing in the up file can recreate them. So this refuses to do anything
# without `--yes`, and prints the versions it would roll back first. If the data still matters, recover
# to the restore point taken before the deployment instead: see docs/data-durability.md.
#
# `--to` names the version you want to be left at, so `--to 0006` rolls back 0009, 0008 and 0007.
# `--to 0000` rolls everything back; `schema_migrations` itself survives, by design, so the next apply
# can tell a rolled-back database from a fresh one.
#
# Like `apply.sh`, this asks `schema_migrations` what is actually applied rather than trusting a file
# listing, runs as one locked session, and lets each file's own transaction bound each step.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL to the database to roll back}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LOCK_KEY=778811223344
LOCK_TIMEOUT="${MIGRATIONS_LOCK_TIMEOUT:-120s}"

target=
confirmed=false
one=false

while [ $# -gt 0 ]; do
  case "$1" in
    --to) target="${2:?--to needs a version, such as 0006}"; shift 2 ;;
    --one) one=true; shift ;;
    --yes) confirmed=true; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

query() { psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAc "$1"; }

# Two statements rather than one guarded by a CASE: PostgreSQL parses the whole statement before it
# evaluates any of it, so a subquery over a table that does not exist yet fails whatever guards it.
if [ "$(query "SELECT to_regclass('public.schema_migrations') IS NOT NULL")" = "t" ]; then
  applied="$(query "SELECT coalesce(string_agg(version, ' ' ORDER BY version DESC), '') FROM schema_migrations")"
else
  applied=""
fi

if [ -z "${applied// /}" ]; then
  echo "nothing is applied; there is nothing to roll back"
  exit 0
fi

if [ "$one" = true ]; then
  if [ -n "$target" ]; then echo "--one and --to are alternatives, not both" >&2; exit 2; fi
  # Newest first, so the first entry is the one to undo.
  target="$(echo "$applied" | tr ' ' '\n' | head -1 | awk '{ printf "%04d", $1 - 1 }')"
fi
if [ -z "$target" ]; then echo "name where to stop: --to <version>, or --one" >&2; exit 2; fi

rolling=()
for version in $applied; do
  if [ "$version" \> "$target" ]; then
    file="$(ls "$here/${version}"_*.down.sql 2>/dev/null | head -1 || true)"
    if [ -z "$file" ]; then
      # The ledger says it is applied and there is no file to undo it with: this checkout is older than
      # the database. Rolling back the versions around it would leave the schema in a shape no release
      # has ever run against.
      echo "$version is applied but has no down file in this checkout. Check out the release that applied it and roll back from there." >&2
      exit 1
    fi
    rolling+=("$file")
  fi
done

if [ ${#rolling[@]} -eq 0 ]; then
  echo "already at or below $target; nothing to roll back"
  exit 0
fi

echo "would roll back (${#rolling[@]}), newest first:"
for file in "${rolling[@]}"; do echo "  $(basename "$file" .down.sql)"; done
echo "leaving the schema at $target"

if [ "$confirmed" != true ]; then
  echo
  echo "Nothing was rolled back. A down migration drops what its up file created, and the rows go with it."
  echo "Re-run with --yes once you have a backup and a restore point: see docs/data-durability.md."
  exit 0
fi

{
  echo "SET lock_timeout = '$LOCK_TIMEOUT';"
  echo "SELECT pg_advisory_lock($LOCK_KEY);"
  for file in "${rolling[@]}"; do
    echo "\\echo rolling back $(basename "$file" .down.sql)"
    echo "\\i $file"
  done
} | psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f -

echo "applied: $(query "SELECT coalesce((SELECT string_agg(version, ' ' ORDER BY version) FROM schema_migrations), 'none')")"
