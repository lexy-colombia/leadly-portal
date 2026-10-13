#!/usr/bin/env bash
# Prueba 20261013170000_barriles_enterprise_subscription.sql en un Postgres 15
# descartable (NO toca ninguna base real). Aplica las migraciones REALES de
# billing/modulos/entitlements/planes reales/borrado de planes de prueba, siembra el
# estado "produccion", corre la migracion 2 veces, simula el cron en el tiempo y corre
# casos negativos y mutaciones (cada mutacion debe hacer fallar la prueba).
# Uso: tests/barriles_subscription/run.sh -> "RESUMEN N PASS, M FAIL"; exit != 0 ante fallo.
set -uo pipefail
PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@15/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
MIGS="$HERE/../../migrations"
NEW="${MIG_OVERRIDE:-$MIGS/20261013170000_barriles_enterprise_subscription.sql}"
WORK=$(mktemp -d); PORT=${PGPORT_TEST:-54371}
export PGHOST=127.0.0.1 PGPORT=$PORT PGUSER=postgres PGDATABASE=postgres
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
build_base() {
  export PGOPTIONS='-c client_min_messages=warning'
  $P -f "$HERE/00_stubs.sql" >/dev/null || fail_setup "stubs"
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
  $P -f "$HERE/05_pre_seed.sql" >/dev/null || fail_setup "pre seed"
  $P -f "$MIGS/20261013150000_load_real_plans.sql" >/dev/null || fail_setup "load_real_plans"
  $P -f "$MIGS/20261013160000_delete_test_plans.sql" >/dev/null || fail_setup "delete_test_plans"
  $P -f "$HERE/06_post_seed.sql" >/dev/null || fail_setup "post seed"
  unset PGOPTIONS
}

# Reloj falso: reemplaza now()/current_date en las 3 funciones de cron por t.clock.
patch_clock() {
  $P -c "create table if not exists public.zz_clock(now timestamptz);
         delete from public.zz_clock; insert into public.zz_clock values ('2026-10-12 12:00:00-05');
         create or replace function public.zz_now() returns timestamptz language sql stable as \$\$ select now from public.zz_clock \$\$;" >/dev/null || fail_setup "clock"
  for fn in process_recurring_billing_invoices deactivate_tenants_with_overdue_invoices mark_overdue_invoices; do
    $P -c "select pg_get_functiondef('public.$fn()'::regprocedure)" > "$WORK/$fn.sql"
    sed -i '' -e 's/now()/public.zz_now()/g' -e 's/current_date/public.zz_now()::date/g' "$WORK/$fn.sql"
    $P -f "$WORK/$fn.sql" >/dev/null || fail_setup "patch $fn"
  done
}
setclock() { $P -c "update public.zz_clock set now = '$1'" >/dev/null; }
crons() {
  $P -c "select public.process_recurring_billing_invoices(); select public.deactivate_tenants_with_overdue_invoices();" >/dev/null
}

fp() { # $1 = fase
  $P -c "insert into r.fp(phase,k,n,h)
    select '$1','other_tenants',count(*),md5(coalesce(string_agg(t::text,'|' order by t.id),'')) from public.tenants t where t.id <> '$B'
    union all select '$1','other_tem',count(*),md5(coalesce(string_agg(m::text,'|' order by m.tenant_id,m.module_key),'')) from public.tenant_enabled_modules m where m.tenant_id <> '$B'
    union all select '$1','plans',count(*),md5(coalesce(string_agg(p::text,'|' order by p.id),'')) from public.billing_plans p
    union all select '$1','plan_modules',count(*),md5(coalesce(string_agg(m::text,'|' order by m.plan_id,m.module_key),'')) from public.billing_plan_modules m
    union all select '$1','other_subs',count(*),md5(coalesce(string_agg(s::text,'|' order by s.id),'')) from public.billing_subscriptions s where s.tenant_id <> '$B'
    union all select '$1','other_inv',count(*),md5(coalesce(string_agg(i::text,'|' order by i.id),'')) from public.payment_invoices i where i.payer_tenant_id <> '$B'
    union all select '$1','b_manual',count(*),md5(coalesce(string_agg(m::text,'|' order by m.module_key),'')) from public.tenant_enabled_modules m where m.tenant_id = '$B' and m.source = 'manual'
    union all select '$1','b_tem',count(*),'' from public.tenant_enabled_modules m where m.tenant_id = '$B'
    union all select '$1','b_subs',count(*),'' from public.billing_subscriptions s where s.tenant_id = '$B'
    union all select '$1','b_inv',count(*),'' from public.payment_invoices i where i.payer_tenant_id = '$B'
    union all select '$1','b_sub_modules',count(*),'' from public.billing_subscription_modules
    union all select '$1','b_state',count(*),md5(coalesce(string_agg(x,'|' order by x),'')) from (
        select s::text x from public.billing_subscriptions s where s.tenant_id = '$B'
        union all select i::text from public.payment_invoices i where i.payer_tenant_id = '$B'
        union all select it::text from public.payment_invoice_items it join public.payment_invoices i on i.id = it.invoice_id where i.payer_tenant_id = '$B'
        union all select sm::text from public.billing_subscription_modules sm
        union all select a::text from public.payment_attempts a join public.payment_invoices i on i.id = a.invoice_id where i.payer_tenant_id = '$B') z" >/dev/null
}
chk() { # $1 nombre, $2 expresion SQL booleana
  local r; r=$($P -c "select coalesce(($2), false)")
  local ok=false; [ "$r" = t ] && ok=true
  $P -c "insert into r.results(name,ok,detail) values ('$1', $ok, null)" >/dev/null
  if [ "$ok" = true ]; then echo "PASS  $1"; else echo "FAIL  $1"; fi
}
fpv() { echo "(select $3 from r.fp where phase='$1' and k='$2')"; }
SUB="(select id from public.billing_subscriptions where tenant_id='$B')"
INVA="(select id from public.payment_invoices where payer_tenant_id='$B' and due_date='2026-10-10')"
INVB="(select id from public.payment_invoices where payer_tenant_id='$B' and due_date='2026-11-10')"

echo "== base (migraciones REALES + estado produccion)"
build_base
fp before
echo "== migracion (1a vez)"
OUT1=$($P -f "$NEW" 2>&1); RC1=$?
echo "$OUT1" | sed -E 's/^psql:[^ ]+ //' | grep -E 'NOTICE|ERROR' || true
fp after1
echo "== migracion (2a vez)"
OUT2=$($P -f "$NEW" 2>&1); RC2=$?
echo "$OUT2" | sed -E 's/^psql:[^ ]+ //' | grep -E 'NOTICE|ERROR' || true
fp after2

chk "A0 la migracion corre sin error (rc=0)" "$([ "$RC1" -eq 0 ] && echo true || echo false)"
chk "A1 una suscripcion enterprise ACTIVE, base 14000000, implementacion 0, billed_at no nulo, sin cancelar" \
  "(select count(*)=1 and bool_and(p.key='enterprise' and s.status='ACTIVE' and s.custom_base_amount_cents=14000000 and s.setup_fee_override_cents=0 and s.setup_fee_billed_at is not null and s.cancel_at_period_end=false) from public.billing_subscriptions s join public.billing_plans p on p.id=s.plan_id where s.tenant_id='$B')"
chk "A2 periodo vigente 2026-10-10 -> 2026-11-10 (00:00 Bogota)" \
  "(select current_period_start='2026-10-10 00:00:00-05' and current_period_end='2026-11-10 00:00:00-05' from public.billing_subscriptions where tenant_id='$B')"
chk "A3 exactamente 2 facturas: PAID due 2026-10-10 y PENDING due 2026-11-10, ambas 14000000" \
  "(select count(*)=2 and count(*) filter (where status='PAID' and due_date='2026-10-10' and amount_cents=14000000)=1 and count(*) filter (where status='PENDING' and due_date='2026-11-10' and amount_cents=14000000)=1 from public.payment_invoices where payer_tenant_id='$B' and deleted_at is null)"
chk "A4 suma de items = monto en cada factura" \
  "(select bool_and(coalesce((select sum(subtotal_cents) from public.payment_invoice_items it where it.invoice_id=i.id),0)=i.amount_cents) from public.payment_invoices i where i.payer_tenant_id='$B')"
chk "A5 0 lineas de implementacion (aunque el plan tenga implementacion hipotetica de 50.000)" \
  "(select count(*)=0 from public.payment_invoice_items it join public.payment_invoices i on i.id=it.invoice_id where i.payer_tenant_id='$B' and it.description like 'Implementaci%') and (select setup_fee_cents=5000000 from public.billing_plans where key='enterprise')"
chk "A6 modulos pactados = catalogo completo (entitlement_module_keys), todos a 0 con la nota" \
  "(select count(*)=cardinality(public.entitlement_module_keys()) and bool_and(price_cents=0 and note='Incluido sin costo (acuerdo con el cliente)') and array_agg(module_key order by module_key)=(select array_agg(k order by k) from unnest(public.entitlement_module_keys()) k) from public.billing_subscription_modules where subscription_id=$SUB)"
chk "A7 intento de pago: 1 manual APPROVED 14000000 sobre la factura historica, creado 2026-09-10; la pendiente sin intentos" \
  "(select count(*)=1 and bool_and(provider_key='manual' and status='APPROVED' and amount_cents=14000000 and created_at='2026-09-10 00:00:00-05' and invoice_id=$INVA) from public.payment_attempts) and not exists (select 1 from public.payment_attempts where invoice_id=$INVB)"
chk "A8 factura historica emitida 2026-09-10 y numero INV-20260910-*" \
  "(select created_at='2026-09-10 00:00:00-05' and invoice_number like 'INV-20260910-%' and provider_payment_method='transferencia' from public.payment_invoices where id=$INVA)"
chk "A9 snapshot del comprador e IVA 19% en ambas facturas (subtotal+iva=monto)" \
  "(select bool_and(buyer_legal_name='INVERSIONES GASTRONOMICAS DEL HUILA SAS' and buyer_document_number='902086977' and tax_rate=19 and subtotal_cents+tax_cents=amount_cents) from public.payment_invoices where payer_tenant_id='$B')"
chk "A10 factura pendiente: 1 linea base 14000000 + lineas de modulo todas a 0 (24)" \
  "(select count(*) filter (where unit_price_cents=14000000)=1 and count(*) filter (where description like 'Módulo:%' and unit_price_cents=0)=24 and count(*)=25 from public.payment_invoice_items where invoice_id=$INVB)"
chk "A11 modulos habilitados: catalogo completo; los 21 manuales intactos (huella md5); los 3 nuevos son source=subscription" \
  "$(fpv before b_manual h)=$(fpv after1 b_manual h) and $(fpv after1 b_manual n)=21 and $(fpv after1 b_tem n)=24 and (select count(*)=3 and bool_and(source='subscription') from public.tenant_enabled_modules where tenant_id='$B' and module_key in ('campaigns','automations','storefront'))"
chk "A12 otros tenants, modulos, planes, modulos de plan, suscripciones y facturas ajenas intactos (huellas md5)" \
  "$(fpv before other_tenants h)=$(fpv after1 other_tenants h) and $(fpv before other_tem h)=$(fpv after1 other_tem h) and $(fpv before plans h)=$(fpv after1 plans h) and $(fpv before plan_modules h)=$(fpv after1 plan_modules h) and $(fpv before other_subs h)=$(fpv after1 other_subs h) and $(fpv before other_inv h)=$(fpv after1 other_inv h) and $(fpv after1 other_inv n)=1"
chk "A13 re-ejecucion: sin error, avisa ya aplicada, y estado de Barriles identico (huella md5)" \
  "$([ "$RC2" -eq 0 ] && echo true || echo false) and $(echo "$OUT2" | grep -q 'ya aplicada' && echo true || echo false) and $(fpv after1 b_state h)=$(fpv after2 b_state h) and $(fpv after2 b_subs n)=1 and $(fpv after2 b_inv n)=2"

echo "== crons con reloj falso"
patch_clock
setclock '2026-10-12 12:00:00-05'
crons
chk "T1 hoy (2026-10-12): Barriles sigue active tras mark_overdue + deactivate" "(select status='active' from public.tenants where id='$B')"
chk "T2 hoy: el cron de renovacion no avanzo el periodo ni duplico facturas" \
  "(select current_period_end='2026-11-10 00:00:00-05' from public.billing_subscriptions where tenant_id='$B') and (select count(*)=2 from public.payment_invoices where payer_tenant_id='$B') and (select count(*)=1 from public.payment_invoices where payer_tenant_id='$B' and status='PENDING')"
setclock '2026-11-07 07:00:00-05'
crons
chk "T3 2026-11-07 07:00: el cron avanza a 2026-11-10 -> 2026-12-10 y genera factura due 2026-12-10 PENDING 14000000 (24 modulos a 0, sin implementacion)" \
  "(select current_period_start='2026-11-10 00:00:00-05' and current_period_end='2026-12-10 00:00:00-05' from public.billing_subscriptions where tenant_id='$B') and (select count(*)=1 and bool_and(status='PENDING' and amount_cents=14000000) from public.payment_invoices where payer_tenant_id='$B' and due_date='2026-12-10') and (select count(*)=0 from public.payment_invoice_items it join public.payment_invoices i on i.id=it.invoice_id where i.due_date='2026-12-10' and i.payer_tenant_id='$B' and it.description like 'Implementaci%')"
crons
chk "T4 segunda corrida el mismo dia: sin duplicados" "(select count(*)=3 from public.payment_invoices where payer_tenant_id='$B') and (select current_period_end='2026-12-10 00:00:00-05' from public.billing_subscriptions where tenant_id='$B')"
chk "T5 2026-11-07: Barriles sigue active (factura de 11-10 aun no vencida)" "(select status='active' from public.tenants where id='$B')"
setclock '2026-11-14 12:00:00-05'
crons
chk "T6 control: sin pagar la factura del 2026-11-10, a 2026-11-14 el cron SI desactiva (la prueba no es vacua)" "(select status='inactive' from public.tenants where id='$B')"

echo "== negativos"
neg() { # $1 nombre, $2 sql de preparacion
  echo "-- negativo: $1"
  build_base
  $P -c "$2" >/dev/null || fail_setup "prep $1"
  local out rc s i
  out=$($P -f "$NEW" 2>&1); rc=$?
  echo "$out" | sed -E 's/^psql:[^ ]+ //' | grep -m1 -E 'ERROR' || true
  s=$($P -c "select count(*) from public.billing_subscriptions where tenant_id='$B' and custom_base_amount_cents=14000000")
  chk "$1: aborta (exit != 0)" "$([ $rc -ne 0 ] && echo true || echo false)"
  chk "$1: mensaje de la guarda" "$(echo "$out" | grep -q 'barriles_enterprise_subscription' && echo true || echo false)"
  chk "$1: no escribio la suscripcion pactada" "$([ "$s" = 0 ] && echo true || echo false)"
}
neg "N1 tenant con otro nombre" "update public.tenants set name='Otro' where id='$B'"
neg "N2 ya hay una suscripcion distinta" "insert into public.billing_subscriptions(tenant_id, plan_id, status) select '$B', id, 'ACTIVE' from public.billing_plans where key='business'"
neg "N3 factura de plataforma preexistente" "insert into public.payment_invoices(payer_tenant_id, provider_key, amount_cents, status) values ('$B','manual',100,'PENDING')"
neg "N4 plan enterprise ya no es is_custom" "update public.billing_plans set is_custom=false where key='enterprise'"

# Mutaciones: cada una debe hacer fallar la prueba (exit != 0). NO_MUT evita recursion.
if [ -z "${NO_MUT:-}" ]; then
  echo "== mutaciones"
  mut() { # $1 nombre, $2 expresion sed, $3 puerto
    sed -E "$2" "$MIGS/20261013170000_barriles_enterprise_subscription.sql" > "$WORK/mut.sql"
    if cmp -s "$WORK/mut.sql" "$MIGS/20261013170000_barriles_enterprise_subscription.sql"; then
      chk "$1: la mutacion se aplico" false; return
    fi
    NO_MUT=1 MIG_OVERRIDE="$WORK/mut.sql" PGPORT_TEST=$3 "$0" > "$WORK/mut.out" 2>&1; local rc=$?
    echo "   $1 -> exit $rc: $(grep RESUMEN "$WORK/mut.out")"
    chk "$1: la prueba falla con la migracion mutada (exit 1)" "$([ $rc -eq 1 ] && echo true || echo false)"
  }
  mut "M1 sin override ni billed_at (aparece cobro de implementacion)" \
      '/-- M1$/ s/:= [^;]*;/:= null;/' 54372
  mut "M2 sin pago de la factura historica (queda PENDING due 2026-10-10)" \
      's/if true then -- M2/if false then -- M2/' 54373
  mut "M3 sin modulos del catalogo" \
      's/if true then -- M3/if false then -- M3/' 54374
fi

NPASS=$($P -c "select count(*) from r.results where ok")
NFAIL=$($P -c "select count(*) from r.results where not ok")
echo "RESUMEN $NPASS PASS, $NFAIL FAIL"
if [ "$NFAIL" -ne 0 ] || [ "$NPASS" -eq 0 ]; then exit 1; fi
exit 0
