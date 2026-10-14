#!/usr/bin/env bash
set -euo pipefail
# Run only in the assembled source tree. Never materialize ONREZA variables here.
cd "$(dirname "$0")"
browser=$(command -v chromium)
scratch=$(mktemp -d /tmp/club-prodamus-isolated.XXXXXX)
port=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();})')
unset PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGOPTIONS PGSERVICE PGSERVICEFILE PGSSLMODE PGDATA
cleanup(){
  pg_ctl -D "$scratch/postgres" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT
initdb -D "$scratch/postgres" --username=club_test --auth=trust --no-locale --encoding=UTF8 --no-sync >"$scratch/init.log" 2>&1
pg_ctl -D "$scratch/postgres" -l "$scratch/server.log" -o "-h 127.0.0.1 -p $port -k $scratch" -w start >/dev/null
env -i PATH="$PATH" PGSSLMODE=disable createdb -h 127.0.0.1 -p "$port" -U club_test club_cloudpayments_test
for file in server.mjs admin-access.mjs admin-store.mjs admin.js cloudpayments-store.mjs mail-monitor.mjs email.mjs prodamus-mail.mjs; do node --check "$file"; done
mkdir -p "$scratch/home" "$scratch/config" "$scratch/cache"
tests=("$@")
if [[ ${#tests[@]} -eq 0 ]]; then tests=(*.test.mjs); fi
env -i PATH="$PATH" HOME="$scratch/home" XDG_CONFIG_HOME="$scratch/config" XDG_CACHE_HOME="$scratch/cache" \
  PGSSLMODE=disable CLUB_TEST_CHROMIUM="$browser" CLUB_TEST_SCREENSHOT_DIR=/tmp/club-prodamus-admin-screenshots \
  CLOUDPAYMENTS_TEST_DB_URL="postgresql://club_test@127.0.0.1:$port/club_cloudpayments_test?sslmode=disable" \
  node --test --test-timeout=90000 "${tests[@]}"
