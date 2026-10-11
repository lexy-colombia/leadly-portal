#!/usr/bin/env bash
# Prueba de integración real: router de P2 + funciones SQL reales de P1 en un
# Postgres 15 descartable (NO toca ninguna base real).
# Uso: tests/payments/run_integration.sh
set -euo pipefail
PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@15/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
MIG="$HERE/../../migrations/20261011190000_payments_schema.sql"
MIG2="$HERE/../../migrations/20261011210000_payments_legacy_origins.sql"
MIG3="$HERE/../../migrations/20261011230000_payments_public_link_status.sql"
WORK=$(mktemp -d)
PORT=${PGPORT_TEST:-54330}
"$PGBIN/initdb" -D "$WORK/data" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$WORK" -l "$WORK/pg.log" -w start >/dev/null
trap '"$PGBIN/pg_ctl" -D "$WORK/data" -m fast stop >/dev/null; rm -rf "$WORK"' EXIT
P="$PGBIN/psql -X -v ON_ERROR_STOP=1 -q -h 127.0.0.1 -p $PORT -U postgres"
$P -d postgres -c "create database rt"
$P -d rt -f "$HERE/00_stubs.sql" >/dev/null
$P -d rt -f "$MIG" >/dev/null
$P -d rt -f "$MIG2" >/dev/null
$P -d rt -f "$MIG2" >/dev/null   # idempotencia
$P -d rt -f "$MIG3" >/dev/null
$P -d rt -f "$MIG3" >/dev/null   # idempotencia
$P -d rt -f "$HERE/40_legacy_stubs.sql" >/dev/null
DATABASE_URL="postgres://postgres@127.0.0.1:$PORT/rt" deno run -A "$HERE/integration_real.ts" 2>&1 | grep -E "^(FAIL|RESUMEN|==|INFO)"
