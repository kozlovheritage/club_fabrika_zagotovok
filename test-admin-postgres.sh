#!/usr/bin/env bash
set -euo pipefail
# Execute from the assembled club source root. No real secrets/database inherited.
cd "$(dirname "$0")"
browser=$(command -v chromium)
screenshots="${CLUB_TEST_SCREENSHOT_DIR:-/tmp/club-admin-screenshots}"
unset PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGOPTIONS PGSERVICE PGSERVICEFILE PGSSLMODE PGDATA
pgdir=$(mktemp -d /tmp/club-admin-postgres.XXXXXX)
cleanup() {
  pg_ctl -D "$pgdir" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$pgdir" "${pgdir}.init.log" "${pgdir}.server.log"
}
trap cleanup EXIT
initdb -D "$pgdir" --username=club_test --auth=trust --no-locale --encoding=UTF8 --no-sync > "${pgdir}.init.log" 2>&1
pg_ctl -D "$pgdir" -l "${pgdir}.server.log" -o "-h 127.0.0.1 -p 55439 -k $pgdir" -w start >/dev/null
createdb -h 127.0.0.1 -p 55439 -U club_test club_cloudpayments_test
node --check server.mjs
node --check admin.js
env -i PATH="$PATH" PGSSLMODE=disable \
  CLOUDPAYMENTS_TEST_DB_URL='postgresql://club_test@127.0.0.1:55439/club_cloudpayments_test?sslmode=disable' \
  CLUB_TEST_CHROMIUM="$browser" CLUB_TEST_SCREENSHOT_DIR="$screenshots" \
  node --test *.test.mjs
