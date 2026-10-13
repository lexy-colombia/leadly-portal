#!/usr/bin/env bash
# Prueba 20261013160000_delete_test_plans.sql en un Postgres 15 descartable (NO toca
# ninguna base real). Aplica las migraciones REALES de billing/modulos/entitlements y la
# de planes reales (que renombra a *_prueba), siembra el estado "produccion", corre la
# migracion 2 veces y verifica; despues casos negativos de la guarda.
# MIG_OVERRIDE=<archivo> permite probar una version mutada (la prueba debe fallar).
# Uso: tests/delete_test_plans/run.sh -> "RESUMEN N PASS, M FAIL"; exit != 0 ante fallo.
set -uo pipefail
PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@15/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
MIGS="$HERE/../../migrations"
NEW="${MIG_OVERRIDE:-$MIGS/20261013160000_delete_test_plans.sql}"
WORK=$(mktemp -d); PORT=${PGPORT_TEST:-54361}
export PGHOST=127.0.0.1 PGPORT=$PORT PGUSER=postgres PGDATABASE=postgres
"$PGBIN/initdb" -D "$WORK/data" -U postgres --auth=trust >/dev/null || exit 2
"$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$WORK" -l "$WORK/pg.log" -w start >/dev/null || exit 2
cleanup() { "$PGBIN/pg_ctl" -D "$WORK/data" -m fast stop >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
P="$PGBIN/psql -X -v ON_ERROR_STOP=1 -q -t -A"
fail_setup() { echo "RESUMEN 0 PASS, 1 FAIL (error de preparacion: $1)"; exit 1; }
$P -c "create database ptest" >/dev/null || fail_setup "createdb"
export PGDATABASE=ptest
# Resultados en el schema r (los stubs recrean public/t, r sobrevive entre escenarios)
$P -c "create schema r; create table r.results(n serial primary key, name text, ok boolean, detail text);
       create table r.fp(phase text, k text, n bigint, h text);" >/dev/null || fail_setup "schema r"

build_base() {
  export PGOPTIONS='-c client_min_messages=warning'
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
  $P -f "$MIGS/20261013130000_plans_entitlements.sql" >/dev/null || fail_setup "plans_entitlements"
  $P -f "$HERE/05_prod_seed.sql" >/dev/null || fail_setup "prod seed"
  $P -f "$MIGS/20261013150000_load_real_plans.sql" >/dev/null || fail_setup "load_real_plans"
  unset PGOPTIONS
}

fp() { # $1 = fase
  $P -c "insert into r.fp(phase,k,n,h)
    select '$1','real_plans',count(*),md5(coalesce(string_agg(p::text,'|' order by p.id),'')) from public.billing_plans p where p.key in ('starter','business','business_ai','enterprise')
    union all select '$1','real_plan_modules',count(*),md5(coalesce(string_agg(m::text,'|' order by m.plan_id,m.module_key),'')) from public.billing_plan_modules m where m.plan_id in (select id from public.billing_plans where key in ('starter','business','business_ai','enterprise'))
    union all select '$1','tem',count(*),md5(coalesce(string_agg(m::text,'|' order by m.tenant_id,m.module_key),'')) from public.tenant_enabled_modules m
    union all select '$1','test_plans',count(*),'' from public.billing_plans where key like '%\_prueba'
    union all select '$1','subs',count(*),'' from public.billing_subscriptions
    union all select '$1','plans_total',count(*),'' from public.billing_plans" >/dev/null
}
chk() { # $1 nombre, $2 expresion SQL booleana
  local r; r=$($P -c "select coalesce(($2), false)")
  local ok=false; [ "$r" = t ] && ok=true
  $P -c "insert into r.results(name,ok,detail) values ('$1', $ok, null)" >/dev/null
  if [ "$ok" = true ]; then echo "PASS  $1"; else echo "FAIL  $1"; fi
}
fpv() { echo "(select $3 from r.fp where phase='$1' and k='$2')"; }

echo "== base (migraciones REALES + estado produccion)"
build_base
fp before
echo "-- antes:"; $P -F ' ' -c "select k, n from r.fp where phase='before' order by k"
echo "== migracion (1a vez)"
$P -f "$NEW" 2>&1 | sed -E 's/^psql:[^ ]+ //' | grep -E 'NOTICE|ERROR' || true
fp after1
echo "== migracion (2a vez)"
OUT2=$($P -f "$NEW" 2>&1); RC2=$?
echo "$OUT2" | sed -E 's/^psql:[^ ]+ //' | grep -E 'NOTICE|ERROR' || true
fp after2
echo "-- despues:"; $P -F ' ' -c "select k, n from r.fp where phase='after2' order by k"

chk "A1 antes: 3 planes de prueba y 2 suscripciones" "$(fpv before test_plans n)=3 and $(fpv before subs n)=2"
chk "A2 despues: 0 planes de prueba" "$(fpv after1 test_plans n)=0"
chk "A3 despues: 0 suscripciones" "$(fpv after1 subs n)=0"
chk "A4 total de planes baja de 7 a 4" "$(fpv before plans_total n)=7 and $(fpv after1 plans_total n)=4"
chk "A5 4 planes reales intactos (huella md5)" "$(fpv before real_plans h)=$(fpv after1 real_plans h) and $(fpv after1 real_plans n)=4"
chk "A6 modulos de planes reales intactos (huella md5, n>0)" "$(fpv before real_plan_modules h)=$(fpv after1 real_plan_modules h) and $(fpv after1 real_plan_modules n)>0"
chk "A7 tenant_enabled_modules identico (huella md5, 5 filas)" "$(fpv before tem h)=$(fpv after1 tem h) and $(fpv after1 tem n)=5"
chk "A8 todas las filas siguen source=manual" "not exists (select 1 from public.tenant_enabled_modules where source<>'manual')"
chk "A9 re-ejecucion sin error y estado igual" "$([ "$RC2" -eq 0 ] && echo true || echo false) and $(fpv after1 tem h)=$(fpv after2 tem h) and $(fpv after1 real_plans h)=$(fpv after2 real_plans h) and $(fpv after2 plans_total n)=4"
chk "A10 2a corrida avisa que ya no existen" "$(echo "$OUT2" | grep -q 'ya no existen' && echo true || echo false)"

neg() { # $1 nombre, $2 sql de preparacion
  echo "== negativo: $1"
  build_base
  $P -c "$2" >/dev/null || fail_setup "prep $1"
  local out rc p s
  out=$($P -f "$NEW" 2>&1); rc=$?
  echo "$out" | sed -E 's/^psql:[^ ]+ //' | grep -m1 -E 'ERROR' || true
  p=$($P -c "select count(*) from public.billing_plans where key like '%\_prueba'")
  s=$($P -c "select count(*) from public.billing_subscriptions")
  chk "$1: aborta (exit != 0)" "$([ $rc -ne 0 ] && echo true || echo false)"
  chk "$1: mensaje de la guarda" "$(echo "$out" | grep -q 'delete_test_plans' && echo true || echo false)"
  chk "$1: no borro nada (3 planes, 2 subs)" "$([ "$p" = 3 ] && [ "$s" = 2 ] && echo true || echo false)"
}
neg "B1 factura asociada" "insert into public.payment_invoices(payer_tenant_id, subscription_id, provider_key, amount_cents, status) select tenant_id, id, 'manual', 100, 'PENDING' from public.billing_subscriptions limit 1"
neg "B2 suscripcion de otro tenant" "update public.billing_subscriptions set tenant_id='dddddddd-0000-0000-0000-000000000001' where id='e9146063-95f7-4dbd-8b5f-ad176dce68ed'"
neg "B3 modulos negociados en una suscripcion" "insert into public.billing_subscription_modules(subscription_id, module_key) values ('e9146063-95f7-4dbd-8b5f-ad176dce68ed','sales')"

NPASS=$($P -c "select count(*) from r.results where ok")
NFAIL=$($P -c "select count(*) from r.results where not ok")
echo "RESUMEN $NPASS PASS, $NFAIL FAIL"
if [ "$NFAIL" -ne 0 ] || [ "$NPASS" -eq 0 ]; then exit 1; fi
exit 0
