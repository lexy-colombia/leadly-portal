#!/usr/bin/env bash
# Corre la migracion payments en un Postgres 15 descartable (NO toca ninguna base real).
# Uso: tests/payments/run.sh [directorio_de_trabajo]
set -euo pipefail
PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@15/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
MIG="$HERE/../../migrations/20261011190000_payments_schema.sql"
MIG2="$HERE/../../migrations/20261011210000_payments_legacy_origins.sql"
MIG3="$HERE/../../migrations/20261011230000_payments_public_link_status.sql"
WORK=${1:-$(mktemp -d)}
PORT=${PGPORT_TEST:-54329}
export PGHOST=127.0.0.1 PGPORT=$PORT PGUSER=postgres PGDATABASE=postgres
if [ ! -d "$WORK/data" ]; then "$PGBIN/initdb" -D "$WORK/data" -U postgres --auth=trust >/dev/null; fi
"$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp" -l "$WORK/pg.log" -w start >/dev/null
LOG="$WORK/assertions.log"; : > "$LOG"
summary() {
  rc=$?
  "$PGBIN/pg_ctl" -D "$WORK/data" -m fast stop >/dev/null || true
  npass=$(grep -c '^PASS' "$LOG" || true)
  nfail=$(grep -c 'FAIL:' "$LOG" || true)
  if [ "$rc" -ne 0 ] && [ "$nfail" -eq 0 ]; then nfail=1; fi   # abortó sin una línea FAIL (error de SQL/psql)
  echo "RESUMEN: $npass PASS, $nfail FAIL (exit $rc)"
  exit "$rc"
}
trap summary EXIT
P="$PGBIN/psql -X -v ON_ERROR_STOP=1 -q -t -A"
filt() { sed -E 's/^psql:[^ ]+ NOTICE:  //' | tee -a "$LOG" | grep -E '^(PASS|FAIL|==|psql:|ERROR|DETAIL|CONTEXT|HINT|LINE|filas|reclamos|llamadas)'; }
$P -c "drop database if exists ptest" -c "create database ptest"
export PGDATABASE=ptest
echo "== stubs"; $P -f "$HERE/00_stubs.sql"
echo "== migracion (1a vez)"; $P -f "$MIG"
echo "== migracion (2a vez, idempotencia)"; $P -f "$MIG"
echo "== migracion legacy (1a vez)"; $P -f "$MIG2"
echo "== migracion legacy (2a vez, idempotencia)"; $P -f "$MIG2"
echo "== migracion estado publico (1a vez)"; $P -f "$MIG3"
echo "== migracion estado publico (2a vez, idempotencia)"; $P -f "$MIG3"
echo "== funcional"; $P -f "$HERE/10_functional.sql" 2>&1 | filt
echo "== funcional legacy (fusion del webhook)"; $P -f "$HERE/15_legacy.sql" 2>&1 | filt
echo "== estado publico (retorno de pago)"; $P -f "$HERE/16_public_status.sql" 2>&1 | filt
echo "== seguridad"; $P -f "$HERE/20_security.sql" 2>&1 | filt
echo "== concurrencia begin_link (20 clientes, misma clave)"
$P -f "$HERE/30_conc_setup.sql"
"$PGBIN/pgbench" -n -c 20 -j 20 -t 1 -f "$HERE/30_conc_begin_link.pgb" ptest | grep -E "transactions|failed"
$P -f "$HERE/31_conc_begin_check.sql" 2>&1 | filt
echo "== concurrencia claim_deliveries (10 workers)"
$P -f "$HERE/32_conc_claim_setup.sql"
"$PGBIN/pgbench" -n -c 10 -j 10 -t 5 -f "$HERE/32_conc_claim.pgb" ptest | grep -E "transactions|failed"
$P -f "$HERE/33_conc_claim_check.sql" 2>&1 | filt
echo "== concurrencia record_event (mismo link, 2 APPROVED distintas + repetidas)"
$P -f "$HERE/34_conc_event_setup.sql"
"$PGBIN/pgbench" -n -c 16 -j 16 -t 1 -f "$HERE/34_conc_event.pgb" ptest | grep -E "transactions|failed"
$P -f "$HERE/35_conc_event_check.sql" 2>&1 | filt
echo "== TODO OK"
