# Biblioteca compartida de run.sh (se hace `source`). Postgres 15 descartable.
set -uo pipefail
PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@15/bin}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BAR="$HERE/../barriles_subscription"
MIGS="$HERE/../../migrations"
MIG_A="${MIG_A_OVERRIDE:-$MIGS/20261013165000_delete_barriles_business_subscription.sql}"
MIG_170="$MIGS/20261013170000_barriles_enterprise_subscription.sql"
MIG_180="$MIGS/20261013180000_subscription_period_single_advance.sql"
MIG_B="${MIG_B_OVERRIDE:-$MIGS/20261013190000_correct_moyano_subscription_dates.sql}"
WORK=$(mktemp -d); PORT=${PGPORT_TEST:-54391}
export PGHOST=127.0.0.1 PGPORT=$PORT PGUSER=postgres PGDATABASE=postgres PGTZ=America/Bogota
"$PGBIN/initdb" -D "$WORK/data" -U postgres --auth=trust >/dev/null || exit 2
"$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$WORK" -l "$WORK/pg.log" -w start >/dev/null || exit 2
cleanup() { "$PGBIN/pg_ctl" -D "$WORK/data" -m fast stop >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
P="$PGBIN/psql -X -v ON_ERROR_STOP=1 -q -t -A"
fail_setup() { echo "RESUMEN 0 PASS, 1 FAIL (error de preparacion: $1)"; exit 1; }
$P -c "create database ptest" >/dev/null || fail_setup "createdb"
export PGDATABASE=ptest
$P -c "create schema r; create table r.results(n serial primary key, name text, ok boolean, detail text);
       create table r.fp(phase text, k text, n bigint, h text);" >/dev/null || fail_setup "schema r"

B=9c79437d-1c19-4edc-bc1f-0dc06094823a
BUS=40e2450d-c79c-4c22-bbf2-cff6f57361c3
M=7419c825-4d72-45af-bf40-73375eed9f9c
MSUB=5a79e4bb-3ede-4b83-8966-014ec0b4aa15

build_base() {  # migraciones REALES hasta 20261013160000 + semillas de produccion de otros tenants
  export PGOPTIONS='-c client_min_messages=warning'
  $P -f "$BAR/00_stubs.sql" >/dev/null || fail_setup "stubs"
  for f in 20260807173542_billing_plans 20260807173551_billing_subscriptions 20260807173601_payment_invoices \
           20260807173612_payment_attempts 20260807173621_billing_subscription_activation 20260807173632_recurring_billing_cron \
           20260811000001_tenant_modules; do
    $P -f "$MIGS/$f.sql" >/dev/null || fail_setup "$f"
  done
  sed -n '/drop constraint if exists tenant_enabled_modules_module_key_check/,/\]));/p' "$MIGS/20260913210000_channels_module_and_permissions.sql" > "$WORK/check.sql"
  $P -f "$WORK/check.sql" >/dev/null || fail_setup "check module_key vigente"
  for f in 20260811000004_payment_invoices_dian_fields 20260811000005_manual_payments 20260811000006_billing_plans_max_users \
           20260811000007_billing_plans_max_whatsapp_lines 20260811000008_payment_invoice_items \
           20260811000009_billing_subscriptions_initial_invoice 20260811000010_billing_subscriptions_cancel_at_period_end \
           20260811000011_billing_unify_invoice_creation 20260811000012_billing_auto_deactivate_overdue_tenants; do
    $P -f "$MIGS/$f.sql" >/dev/null || fail_setup "$f"
  done
  awk '/Patrón A/{f=1} f{print} f&&/^end \$\$;/{exit}' "$MIGS/20260822000001_perf_security_hardening.sql" > "$WORK/hardening.sql"
  $P -f "$WORK/hardening.sql" >/dev/null || fail_setup "hardening policies"
  $P -f "$MIGS/20261013130000_plans_entitlements.sql" >/dev/null || fail_setup "plans_entitlements"
  $P -f "$MIGS/20261013140000_billing_functions_revoke_public.sql" >/dev/null || fail_setup "revoke_public"
  $P -f "$BAR/05_pre_seed.sql" >/dev/null || fail_setup "pre seed"
  $P -f "$MIGS/20261013150000_load_real_plans.sql" >/dev/null || fail_setup "load_real_plans"
  $P -f "$MIGS/20261013160000_delete_test_plans.sql" >/dev/null || fail_setup "delete_test_plans"
  $P -f "$BAR/06_post_seed.sql" >/dev/null || fail_setup "post seed"
  $P -f "$HERE/10_prod_state.sql" >/dev/null || fail_setup "estado produccion (Business de Barriles + Moyano)"
  unset PGOPTIONS
}

patch_clock() {  # reloj falso para las funciones de cron
  $P -c "create table if not exists public.zz_clock(now timestamptz);
         delete from public.zz_clock; insert into public.zz_clock values ('2026-10-13 12:00:00-05');
         create or replace function public.zz_now() returns timestamptz language sql stable as \$\$ select now from public.zz_clock \$\$;" >/dev/null || fail_setup "clock"
  for fn in process_recurring_billing_invoices deactivate_tenants_with_overdue_invoices mark_overdue_invoices \
            activate_subscription_on_invoice_paid; do
    $P -c "select pg_get_functiondef('public.$fn()'::regprocedure)" > "$WORK/$fn.sql"
    sed -i '' -e 's/now()/public.zz_now()/g' -e 's/current_date/public.zz_now()::date/g' "$WORK/$fn.sql"
    $P -f "$WORK/$fn.sql" >/dev/null || fail_setup "patch $fn"
  done
  $P -c "select pg_get_functiondef('public.create_invoice_for_subscription(uuid)'::regprocedure)" > "$WORK/cifs.sql"
  sed -i '' -e 's/now()/public.zz_now()/g' "$WORK/cifs.sql"
  $P -f "$WORK/cifs.sql" >/dev/null || fail_setup "patch create_invoice"
}
setclock() { $P -c "update public.zz_clock set now = '$1'" >/dev/null; }
crons() { $P -c "select public.process_recurring_billing_invoices(); select public.deactivate_tenants_with_overdue_invoices();" >/dev/null; }

# Huellas md5. Parametros: fase. "Resto" = todo lo que NO debe cambiar en ninguna correccion.
fp() {
  $P -c "insert into r.fp(phase,k,n,h)
    select '$1','tenants',count(*),md5(coalesce(string_agg(t::text,'|' order by t.id),'')) from public.tenants t
    union all select '$1','plans',count(*),md5(coalesce(string_agg(p::text,'|' order by p.id),'')) from public.billing_plans p
    union all select '$1','plan_modules',count(*),md5(coalesce(string_agg(m::text,'|' order by m.plan_id,m.module_key),'')) from public.billing_plan_modules m
    union all select '$1','tem',count(*),md5(coalesce(string_agg(m::text,'|' order by m.tenant_id,m.module_key),'')) from public.tenant_enabled_modules m
    union all select '$1','other_tem',count(*),md5(coalesce(string_agg(m::text,'|' order by m.tenant_id,m.module_key),'')) from public.tenant_enabled_modules m where m.tenant_id not in ('$B')
    union all select '$1','other_subs',count(*),md5(coalesce(string_agg(s::text,'|' order by s.id),'')) from public.billing_subscriptions s where s.tenant_id not in ('$B','$M')
    union all select '$1','other_inv',count(*),md5(coalesce(string_agg(i::text,'|' order by i.id),'')) from public.payment_invoices i where i.payer_tenant_id not in ('$B','$M')
    union all select '$1','sub_modules_not_b',count(*),md5(coalesce(string_agg(sm::text,'|' order by sm.subscription_id,sm.module_key),'')) from public.billing_subscription_modules sm where sm.subscription_id <> '$BUS'
    union all select '$1','m_state',count(*),md5(coalesce(string_agg(x,'|' order by x),'')) from (
        select s::text x from public.billing_subscriptions s where s.tenant_id = '$M'
        union all select i::text from public.payment_invoices i where i.payer_tenant_id = '$M'
        union all select it::text from public.payment_invoice_items it join public.payment_invoices i on i.id = it.invoice_id where i.payer_tenant_id = '$M'
        union all select a::text from public.payment_attempts a join public.payment_invoices i on i.id = a.invoice_id where i.payer_tenant_id = '$M') z
    union all select '$1','b_subs',count(*),'' from public.billing_subscriptions where tenant_id = '$B'
    union all select '$1','b_inv',count(*),'' from public.payment_invoices where payer_tenant_id = '$B'" >/dev/null
}
chk() { # $1 nombre, $2 expresion SQL booleana
  local r; r=$($P -c "select coalesce(($2), false)")
  local ok=false; [ "$r" = t ] && ok=true
  $P -c "insert into r.results(name,ok,detail) values ('$1', $ok, null)" >/dev/null
  if [ "$ok" = true ]; then echo "PASS  $1"; else echo "FAIL  $1"; fi
}
fpv() { echo "(select $3 from r.fp where phase='$1' and k='$2')"; }
b2s() { [ "$1" = true ] && echo true || echo false; }
finish() {
  NPASS=$($P -c "select count(*) from r.results where ok")
  NFAIL=$($P -c "select count(*) from r.results where not ok")
  echo "RESUMEN $NPASS PASS, $NFAIL FAIL"
  if [ "$NFAIL" -ne 0 ] || [ "$NPASS" -eq 0 ]; then exit 1; fi
  exit 0
}
