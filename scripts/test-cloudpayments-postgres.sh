#!/usr/bin/env bash
set -euo pipefail
# Never inherit the project's database, role, password, service or SSL settings.
unset PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGOPTIONS PGSERVICE PGSERVICEFILE PGSSLMODE PGDATA
export PGSSLMODE=disable
cd "$(dirname "$0")/.."
pgdir=$(mktemp -d /tmp/club-cp-postgres.XXXXXX)
cleanup() {
  pg_ctl -D "$pgdir" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$pgdir" "${pgdir}.init.log" "${pgdir}.server.log"
}
trap cleanup EXIT
if ! initdb -D "$pgdir" --username=club_test --auth=trust --no-locale --encoding=UTF8 --no-sync > "${pgdir}.init.log" 2>&1; then
  cat "${pgdir}.init.log"; exit 1
fi
if ! pg_ctl -D "$pgdir" -l "${pgdir}.server.log" -o "-h 127.0.0.1 -p 55439 -k $pgdir" -w start >/dev/null; then
  cat "${pgdir}.server.log"; exit 1
fi
createdb -h 127.0.0.1 -p 55439 -U club_test club_cloudpayments_test
node --check server.mjs
# Unit tests also get only this whitelist, never the workspace's provider secrets.
env -i PATH="$PATH" PGSSLMODE=disable \
  CLUB_TEST_CHROMIUM="$(command -v chromium)" CLUB_TEST_SCREENSHOT_DIR=/tmp/club-admin-screenshots \
  CLOUDPAYMENTS_TEST_DB_URL='postgresql://club_test@127.0.0.1:55439/club_cloudpayments_test?sslmode=disable' \
  node --test *.test.mjs
