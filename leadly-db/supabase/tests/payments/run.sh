#!/usr/bin/env bash
# Corre la migracion payments en un Postgres 15 descartable (NO toca ninguna base real).
# Uso: tests/payments/run.sh [directorio_de_trabajo]
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
echo "== migracion comercio (1a vez)"; $P -f "$MIG4"
echo "== migracion comercio (2a vez, idempotencia)"; $P -f "$MIG4"
echo "== tablas public simuladas (estado de produccion ANTES del retiro: incluye sales_order_payment_links y provider_checkout_id)"
$P -f "$HERE/40_legacy_stubs.sql"
echo "== ST3: funciones apply_wompi_* (FK de payment_link_id hacia sales_order_payment_links incluida en el stub)"
FKQ="select count(*) from pg_constraint where conrelid='public.sales_order_payments'::regclass and contype='f' and confrelid='public.sales_order_payment_links'::regclass"
[ "$($P -c "$FKQ")" = "1" ] && echo "PASS stub: la FK previa hacia sales_order_payment_links existe" | tee -a "$LOG" || echo "FAIL: el stub no tiene la FK previa" | tee -a "$LOG"
$P -f "$MIG5"
$P -f "$MIG5"   # idempotencia
[ "$($P -c "$FKQ")" = "0" ] && echo "PASS 20261016130000 elimino la FK hacia sales_order_payment_links (sin ella, DROP TABLE sin CASCADE es posible)" | tee -a "$LOG" || echo "FAIL: la FK sigue" | tee -a "$LOG"
$P -f "$MIG6"
$P -f "$MIG6"   # idempotencia
echo "== retiro legacy (20261017120000): ABORTA si queda una fila en sales_order_payment_links"
$P -c "insert into public.tenants(id,name) values ('f0000000-0000-4000-8000-000000000001','T-guard')" \
   -c "insert into public.sales_orders(id,tenant_id,number,status,total) values ('f0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001',1,'confirmada',1)" \
   -c "insert into public.sales_order_payment_links(id,tenant_id,order_id,provider_key,provider_checkout_id,checkout_url,amount) values ('f0000000-0000-4000-8000-000000000003','f0000000-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000002','wompi','guard','http://x',1)"
if $P -f "$MIG7" 2>"$WORK/guard1.err"; then echo "FAIL: la migracion de retiro NO abortó con filas en sales_order_payment_links" | tee -a "$LOG"; else
  grep -q "aun tiene filas" "$WORK/guard1.err" && echo "PASS guarda: aborta con filas en sales_order_payment_links" | tee -a "$LOG" || { echo "FAIL: aborto por otro motivo: $(cat "$WORK/guard1.err")" | tee -a "$LOG"; }; fi
$P -c "delete from public.sales_order_payment_links"
echo "== retiro legacy: ABORTA si queda un provider_checkout_id"
$P -c "insert into public.payment_invoices(id,provider_key,amount_cents,provider_checkout_id) values ('f0000000-0000-4000-8000-000000000004','wompi',1,'wl_guard')"
if $P -f "$MIG7" 2>"$WORK/guard2.err"; then echo "FAIL: la migracion de retiro NO abortó con provider_checkout_id" | tee -a "$LOG"; else
  grep -q "provider_checkout_id aun tiene valores" "$WORK/guard2.err" && echo "PASS guarda: aborta con provider_checkout_id" | tee -a "$LOG" || { echo "FAIL: aborto por otro motivo: $(cat "$WORK/guard2.err")" | tee -a "$LOG"; }; fi
$P -c "delete from public.payment_invoices where id='f0000000-0000-4000-8000-000000000004'" -c "delete from public.sales_orders where id='f0000000-0000-4000-8000-000000000002'" -c "delete from public.tenants where id='f0000000-0000-4000-8000-000000000001'"
echo "== retiro legacy (1a vez)"; $P -f "$MIG7"
echo "== retiro legacy (2a vez, idempotencia)"; $P -f "$MIG7"
echo "== estado final tras el retiro"; $P -f "$HERE/23_retire_legacy.sql" 2>&1 | filt
echo "== funcional"; $P -f "$HERE/10_functional.sql" 2>&1 | filt
echo "== guardia anti-llenado y replay (sin rama legacy)"; $P -f "$HERE/15_flood_guard.sql" 2>&1 | filt
echo "== estado publico (retorno de pago)"; $P -f "$HERE/16_public_status.sql" 2>&1 | filt
echo "== comercio (merchant_tenant_id / kind)"; $P -f "$HERE/17_merchant_scope.sql" 2>&1 | filt
echo "== seguridad"; $P -f "$HERE/20_security.sql" 2>&1 | filt
echo "== ST3: consumidor interno (apply_wompi_* sobre las tablas public simuladas)"; $P -f "$HERE/18_internal_apply.sql" 2>&1 | filt
echo "== ST4: payment_invoices.payments_link_id"; $P -f "$HERE/19_payments_link_id.sql" 2>&1 | filt
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
echo "== limpieza del cliente de prueba (20261016150000) -- base propia, sin datos de otras pruebas"
$P -c "drop database if exists prm" -c "create database prm"
(
  export PGDATABASE=prm
  $P -f "$HERE/00_stubs.sql" >/dev/null
  for m in "$MIG" "$MIG2" "$MIG3" "$MIG4"; do $P -f "$m" >/dev/null; done
  MIG_REMOVE="$HERE/../../migrations/20261016150000_remove_sandbox_payments_client.sql" $PGBIN/psql -X -q -t -A -f "$HERE/21_remove_sandbox_client.sql" 2>&1 | filt
)
export PGDATABASE=ptest
echo "== reversion del pago de prueba de Barriles (20261020120000) -- base propia"
$P -c "drop database if exists prv" -c "create database prv"
(
  export PGDATABASE=prv
  $P -f "$HERE/00_stubs.sql" >/dev/null
  for m in "$MIG" "$MIG2" "$MIG3" "$MIG4"; do $P -f "$m" >/dev/null; done
  MIG_REVERT="$HERE/../../migrations/20261020120000_revert_barriles_sandbox_test_payment.sql" $PGBIN/psql -X -q -t -A -f "$HERE/23_revert_barriles_test_payment.sql" 2>&1 | filt
)
export PGDATABASE=ptest
echo "== TODO OK"
