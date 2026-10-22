#!/usr/bin/env bash
# Prueba de integración real: router de P2 + funciones SQL reales de P1 en un
# Postgres 15 descartable (NO toca ninguna base real).
# Uso: tests/payments/run_integration.sh            (esquema DESPUES de 20261017120000_payments_retire_legacy.sql)
#      PRE_RETIRE=1 tests/payments/run_integration.sh  (esquema ANTES de esa migracion: el codigo nuevo debe funcionar igual)
set -euo pipefail
PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@15/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
MIG="$HERE/../../migrations/20261011190000_payments_schema.sql"
MIG2="$HERE/../../migrations/20261011210000_payments_legacy_origins.sql"
MIG3="$HERE/../../migrations/20261011230000_payments_public_link_status.sql"
MIG4="$HERE/../../migrations/20261016120000_payments_merchant_scope.sql"
MIG5="$HERE/../../migrations/20261016130000_wompi_internal_apply_functions.sql"
MIG6="$HERE/../../migrations/20261016140000_payment_invoices_payments_link_id.sql"
MIG7="$HERE/../../migrations/20261017120000_payments_retire_legacy.sql"
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
$P -d rt -f "$MIG4" >/dev/null
$P -d rt -f "$MIG4" >/dev/null   # idempotencia
$P -d rt -f "$HERE/40_legacy_stubs.sql" >/dev/null
$P -d rt -f "$MIG5" >/dev/null
$P -d rt -f "$MIG5" >/dev/null   # idempotencia
$P -d rt -f "$MIG6" >/dev/null   # ST4: payment_invoices.payments_link_id
$P -d rt -f "$MIG6" >/dev/null   # idempotencia
if [ -z "${PRE_RETIRE:-}" ]; then
  $P -d rt -f "$MIG7" >/dev/null
  $P -d rt -f "$MIG7" >/dev/null   # idempotencia
  echo "INFO esquema: DESPUES del retiro legacy"
else
  echo "INFO esquema: ANTES del retiro legacy (PRE_RETIRE=1)"
fi
DATABASE_URL="postgres://postgres@127.0.0.1:$PORT/rt" deno run -A "$HERE/integration_real.ts" 2>&1 | grep -E "^(FAIL|RESUMEN|==|INFO)"
