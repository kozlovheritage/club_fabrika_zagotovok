#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
browser=$(command -v chromium)
unset PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGOPTIONS PGSERVICE PGSERVICEFILE PGSSLMODE PGDATA
pgdir=$(mktemp -d /tmp/club-password-tests.XXXXXX)
cleanup() {
  pg_ctl -D "$pgdir" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$pgdir" "${pgdir}.log"
}
trap cleanup EXIT
initdb -D "$pgdir" --username=club_test --auth=trust --no-locale --encoding=UTF8 --no-sync >/dev/null
pg_ctl -D "$pgdir" -l "${pgdir}.log" -o "-h 127.0.0.1 -p 55439 -k $pgdir" -w start >/dev/null
createdb -h 127.0.0.1 -p 55439 -U club_test club_cloudpayments_test
# File-level concurrency can starve simultaneously booting full-app fixtures.
# Keep the actual app/browser/payment checks serial and never inherit real keys.
env -i PATH="$PATH" PGSSLMODE=disable \
  CLOUDPAYMENTS_TEST_DB_URL='postgresql://club_test@127.0.0.1:55439/club_cloudpayments_test?sslmode=disable' \
  CLUB_TEST_CHROMIUM="$browser" CLUB_TEST_SCREENSHOT_DIR="${CLUB_TEST_SCREENSHOT_DIR:-/tmp/club-password-screenshots}" \
  node --test --test-concurrency=1 admin-support.test.mjs cloudpayments-application.test.mjs prodamus-mail.test.mjs
