#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
browser=$(command -v chromium)
unset PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGOPTIONS PGSERVICE PGSERVICEFILE PGSSLMODE PGDATA
pgdir=$(mktemp -d /tmp/club-password-tests.XXXXXX)
fixture=$(mktemp -d /tmp/club-password-fixture.XXXXXX)
cleanup() {
  pg_ctl -D "$pgdir" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$pgdir" "${pgdir}.log" "$fixture"
}
trap cleanup EXIT
# Verify the real closed-sales gate, then open checkout only inside a disposable
# source fixture so historical payment tests can create synthetic orders.
node --test sales-closure.test.mjs
tar --exclude=.git --exclude=node_modules -cf - . | tar -xf - -C "$fixture"
ln -s "$PWD/node_modules" "$fixture/node_modules"
printf '%s\n' 'export function rejectClosedSales(req,res,next){next();}' > "$fixture/sales-closure.mjs"
initdb -D "$pgdir" --username=club_test --auth=trust --no-locale --encoding=UTF8 --no-sync >/dev/null
pg_ctl -D "$pgdir" -l "${pgdir}.log" -o "-h 127.0.0.1 -p 55439 -k $pgdir" -w start >/dev/null
createdb -h 127.0.0.1 -p 55439 -U club_test club_cloudpayments_test
cd "$fixture"
# File-level concurrency can starve simultaneously booting full-app fixtures.
# Keep the actual app/browser/payment checks serial and never inherit real keys.
env -i PATH="$PATH" PGSSLMODE=disable \
  CLOUDPAYMENTS_TEST_DB_URL='postgresql://club_test@127.0.0.1:55439/club_cloudpayments_test?sslmode=disable' \
  CLUB_TEST_CHROMIUM="$browser" CLUB_TEST_SCREENSHOT_DIR="${CLUB_TEST_SCREENSHOT_DIR:-/tmp/club-password-screenshots}" \
  node --test --test-concurrency=1 account-deletion.test.mjs admin-support.test.mjs cloudpayments-application.test.mjs prodamus-mail.test.mjs
