#!/usr/bin/env bash
# Prueba 20261013150000_load_real_plans.sql en un Postgres 15 descartable (NO toca
# ninguna base real). Aplica las migraciones REALES de billing/modulos y la de
# entitlements, siembra el estado "produccion", corre la migracion 3 veces y verifica.
# Al final corre una MUTACION (rompe la lista de modulos de Business AI) y exige que la prueba falle.
# Uso: tests/real_plans/run.sh -> "RESUMEN N PASS, M FAIL"; exit != 0 ante cualquier fallo.
set -uo pipefail
PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@15/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
MIGS="$HERE/../../migrations"
NEW="${MIG_OVERRIDE:-$MIGS/20261013150000_load_real_plans.sql}"
WORK=$(mktemp -d); PORT=${PGPORT_TEST:-54351}
export PGHOST=127.0.0.1 PGPORT=$PORT PGUSER=postgres PGDATABASE=postgres
"$PGBIN/initdb" -D "$WORK/data" -U postgres --auth=trust >/dev/null || exit 2
"$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$WORK" -l "$WORK/pg.log" -w start >/dev/null || exit 2
cleanup() { "$PGBIN/pg_ctl" -D "$WORK/data" -m fast stop >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
P="$PGBIN/psql -X -v ON_ERROR_STOP=1 -q -t -A"
fail_setup() { echo "RESUMEN 0 PASS, 1 FAIL (error de preparacion: $1)"; exit 1; }
$P -c "create database ptest" >/dev/null || fail_setup "createdb"
export PGDATABASE=ptest

echo "== esqueleto + migraciones REALES previas"
$P -f "$HERE/00_stubs.sql" >/dev/null || fail_setup "stubs"
for f in 20260807173542_billing_plans 20260807173551_billing_subscriptions 20260807173601_payment_invoices \
         20260807173621_billing_subscription_activation 20260807173632_recurring_billing_cron \
         20260811000001_tenant_modules; do
  $P -f "$MIGS/$f.sql" >/dev/null || fail_setup "$f"
done
sed -n '/drop constraint if exists tenant_enabled_modules_module_key_check/,/\]));/p' "$MIGS/20260913210000_channels_module_and_permissions.sql" > "$WORK/check.sql"
$P -f "$WORK/check.sql" >/dev/null || fail_setup "check module_key vigente"
for f in 20260811000004_payment_invoices_dian_fields 20260811000006_billing_plans_max_users \
         20260811000007_billing_plans_max_whatsapp_lines 20260811000008_payment_invoice_items \
         20260811000009_billing_subscriptions_initial_invoice 20260811000010_billing_subscriptions_cancel_at_period_end \
         20260811000011_billing_unify_invoice_creation 20260811000012_billing_auto_deactivate_overdue_tenants; do
  $P -f "$MIGS/$f.sql" >/dev/null || fail_setup "$f"
done
awk '/Patrón A/{f=1} f{print} f&&/^end \$\$;/{exit}' "$MIGS/20260822000001_perf_security_hardening.sql" > "$WORK/hardening.sql"
$P -f "$WORK/hardening.sql" >/dev/null || fail_setup "hardening policies"
echo "== entitlements (20261013130000, ya aplicada en produccion)"
$P -f "$MIGS/20261013130000_plans_entitlements.sql" >/dev/null || fail_setup "plans_entitlements"

echo "== estado produccion sembrado"
$P -f "$HERE/05_prod_seed.sql" >/dev/null || fail_setup "prod seed"

echo "== migracion (1a vez)"
$P -f "$NEW" >/dev/null || fail_setup "migracion (1a vez)"

echo "== pruebas"
$PGBIN/psql -X -q -v ON_ERROR_STOP=1 -f "$HERE/10_tests.sql" 2>&1 | sed -E 's/^psql:[^ ]+ //' | sed -E 's/^NOTICE:  //'
RC=${PIPESTATUS[0]}
[ "$RC" -eq 0 ] || { echo "RESUMEN: el script de pruebas aborto (psql exit $RC)"; N=$($P -c "select count(*) filter (where ok) from t.results" 2>/dev/null || echo 0); echo "RESUMEN $N PASS, 1 FAIL"; exit 1; }

echo "== migracion (2a y 3a vez: idempotencia)"
$P -f "$NEW" >/dev/null || fail_setup "migracion (2a vez)"
$P -f "$NEW" >/dev/null || fail_setup "migracion (3a vez)"
$PGBIN/psql -X -q -v ON_ERROR_STOP=1 -f "$HERE/11_after_rerun.sql" 2>&1 | sed -E 's/^NOTICE:  //'
RC=${PIPESTATUS[0]}
[ "$RC" -eq 0 ] || { echo "RESUMEN 0 PASS, 1 FAIL (11_after_rerun aborto, exit $RC)"; exit 1; }

NPASS=$($P -c "select count(*) from t.results where ok")
NFAIL=$($P -c "select count(*) from t.results where not ok")
echo "== detalle de fallos (si hay)"
$P -c "select name || ' -- ' || coalesce(detail,'') from t.results where not ok"
echo "RESUMEN $NPASS PASS, $NFAIL FAIL"
if [ "$NFAIL" -ne 0 ] || [ "$NPASS" -eq 0 ]; then exit 1; fi
exit 0
