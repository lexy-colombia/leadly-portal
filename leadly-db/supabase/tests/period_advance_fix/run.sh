#!/usr/bin/env bash
# Prueba 20261013180000_subscription_period_single_advance.sql en un Postgres 15
# descartable (NO toca ninguna base real). Aplica las migraciones REALES de billing
# hasta 20261013170000 (+ la nueva) y simula 6+ ciclos de cobro con reloj falso.
# Reutiliza stubs y semillas de tests/barriles_subscription (solo lectura).
# Uso: ./run.sh -> "RESUMEN N PASS, M FAIL"; exit != 0 ante fallo.
# OLD_TRIGGER=1 restaura la funcion trigger previa (debe hacer fallar la prueba).
set -uo pipefail
PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@15/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
BAR="$HERE/../barriles_subscription"
MIGS="$HERE/../../migrations"
NEW="${MIG_OVERRIDE:-$MIGS/20261013180000_subscription_period_single_advance.sql}"
WORK=$(mktemp -d); PORT=${PGPORT_TEST:-54381}
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
for f in 20261013130000_plans_entitlements 20261013140000_billing_functions_revoke_public; do
  $P -f "$MIGS/$f.sql" >/dev/null || fail_setup "$f"
done
$P -f "$BAR/05_pre_seed.sql" >/dev/null || fail_setup "pre seed"
for f in 20261013150000_load_real_plans 20261013160000_delete_test_plans; do
  $P -f "$MIGS/$f.sql" >/dev/null || fail_setup "$f"
done
$P -f "$BAR/06_post_seed.sql" >/dev/null || fail_setup "post seed"
$P -f "$MIGS/20261013170000_barriles_enterprise_subscription.sql" >/dev/null || fail_setup "barriles 170000"

# Estado de la funcion trigger ANTES de la migracion nueva (privilegios, owner, flags).
FN="select p.prosecdef::text||'|'||coalesce(p.proconfig::text,'')||'|'||p.proowner::regrole::text||'|'||coalesce(p.proacl::text,'')||'|'||
     (select string_agg(t.tgname||':'||t.tgenabled::text, ',' order by t.tgname) from pg_trigger t where t.tgfoid=p.oid)
     from pg_proc p where p.oid='public.activate_subscription_on_invoice_paid()'::regprocedure"
FN_BEFORE=$($P -c "$FN")
if [ -n "${OLD_TRIGGER:-}" ]; then
  awk '/^create or replace function public.activate_subscription_on_invoice_paid/{f=1} f{print} f&&/^\$\$;/{exit}' \
    "$MIGS/20260807173621_billing_subscription_activation.sql" > "$WORK/old_trigger.sql"
  $P -f "$WORK/old_trigger.sql" >/dev/null || fail_setup "old trigger"
else
  OUT=$($P -f "$NEW" 2>&1); RCN=$?
  [ "$RCN" -eq 0 ] || fail_setup "migracion nueva: $OUT"
  $P -f "$NEW" >/dev/null 2>&1; RCN2=$?
fi
FN_AFTER=$($P -c "$FN")
unset PGOPTIONS

# Reloj falso en todas las funciones que usan now()/current_date.
$P -c "create table public.zz_clock(now timestamptz);
       insert into public.zz_clock values ('2026-01-01 08:00:00-05');
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

setclock() { $P -c "update public.zz_clock set now = '$1'" >/dev/null; }
crons() { $P -c "select public.process_recurring_billing_invoices(); select public.deactivate_tenants_with_overdue_invoices();" >/dev/null; }
chk() { # $1 nombre, $2 expresion SQL booleana
  local r; r=$($P -c "select coalesce(($2), false)")
  local ok=false; [ "$r" = t ] && ok=true
  $P -c "insert into r.results(name,ok,detail) values ('$1', $ok, null)" >/dev/null
  if [ "$ok" = true ]; then echo "PASS  $1"; else echo "FAIL  $1"; fi
}
fp() {
  $P -c "insert into r.fp(phase,k,n,h)
    select '$1','plans',count(*),md5(coalesce(string_agg(p::text,'|' order by p.id),'')) from public.billing_plans p where p.key not like 'zz\_%'
    union all select '$1','plan_modules',count(*),md5(coalesce(string_agg(m::text,'|' order by m.plan_id,m.module_key),'')) from public.billing_plan_modules m
    union all select '$1','tem',count(*),md5(coalesce(string_agg(m::text,'|' order by m.tenant_id,m.module_key),'')) from public.tenant_enabled_modules m
    union all select '$1','sub_modules',count(*),md5(coalesce(string_agg(m::text,'|' order by m.subscription_id,m.module_key),'')) from public.billing_subscription_modules m" >/dev/null
}
fpv() { echo "(select $3 from r.fp where phase='$1' and k='$2')"; }

T1=aaaaaaaa-0000-0000-0000-000000000001; T2=aaaaaaaa-0000-0000-0000-000000000002; T3=aaaaaaaa-0000-0000-0000-000000000003
T4=aaaaaaaa-0000-0000-0000-000000000004; T5=aaaaaaaa-0000-0000-0000-000000000005; T6=aaaaaaaa-0000-0000-0000-000000000006
T7=aaaaaaaa-0000-0000-0000-000000000007; T8=aaaaaaaa-0000-0000-0000-000000000008
SUBROW() { echo "(select s from public.billing_subscriptions s where s.tenant_id='$1')"; }
S() { echo "(select $2 from public.billing_subscriptions where tenant_id='$1')"; }
PAY() { $P -c "update public.payment_invoices set status='PAID' where payer_tenant_id='$1' and status in ('PENDING','OVERDUE') and due_date <= '$2'" >/dev/null; }

echo "== 0 la funcion trigger"
fp before
chk "F1 la funcion conserva security definer, search_path, owner, ACL y trigger habilitado" "$([ "$FN_BEFORE" = "$FN_AFTER" ] && echo true || echo false)"
if [ -z "${OLD_TRIGGER:-}" ]; then chk "F2 la migracion es idempotente (2a corrida rc=0)" "$([ "$RCN2" -eq 0 ] && echo true || echo false)"; fi

echo "== setup (reloj 2026-01-01)"
setclock '2026-01-01 08:00:00-05'
$P -c "insert into public.billing_plans(key,name,description,amount_cents,billing_interval,max_users,max_whatsapp_lines) values
         ('zz_m','Zz mensual','t',10000000,'monthly',3,1),('zz_y','Zz anual','t',100000000,'yearly',3,1);
       insert into public.tenants(id,name) select x, 'zz '||x from unnest(array['$T1','$T2','$T3','$T4','$T5','$T6','$T7','$T8']::uuid[]) x;
       insert into public.billing_subscriptions(tenant_id, plan_id, status, current_period_start, current_period_end)
       select t.id, p.id, t.st, t.ps::timestamptz, t.pe::timestamptz from (values
         ('$T1'::uuid,'zz_m','ACTIVE','2026-01-01 00:00:00-05','2026-02-01 00:00:00-05'),
         ('$T2','zz_m','ACTIVE','2026-01-01 00:00:00-05','2026-02-01 00:00:00-05'),
         ('$T3','zz_m','PENDING_PAYMENT','2026-01-01 00:00:00-05','2026-02-01 00:00:00-05'),
         ('$T4','zz_m','PENDING_PAYMENT','2026-01-01 00:00:00-05','2026-02-01 00:00:00-05'),
         ('$T5','zz_y','ACTIVE','2026-01-01 00:00:00-05','2027-01-01 00:00:00-05'),
         ('$T6','zz_m','CANCELLED','2026-01-01 00:00:00-05','2026-02-01 00:00:00-05'),
         ('$T7','zz_m','PAST_DUE','2026-01-01 00:00:00-05','2026-02-01 00:00:00-05'),
         ('$T8','zz_m','EXPIRED','2026-01-01 00:00:00-05','2026-02-01 00:00:00-05')) t(id,pk,st,ps,pe)
       join public.billing_plans p on p.key = t.pk;
       update public.billing_subscriptions set current_period_start=null, current_period_end=null where tenant_id='$T4';" >/dev/null || fail_setup "setup subs"
fp setup
chk "S0 cada suscripcion nace con su factura inicial (8)" "(select count(*)=8 and count(*) filter (where status='PENDING')=8 from public.payment_invoices where payer_tenant_id::text like 'aaaaaaaa-0000%')"

echo "== primer pago (casos 3, 4 y estados no activos)"
setclock '2026-01-10 12:00:00-05'
PAY $T4 2026-12-31
chk "C4 legado (periodo NULL): ACTIVE con [now, now+1 mes]" \
  "(select status='ACTIVE' and current_period_start='2026-01-10 12:00:00-05' and current_period_end='2026-02-10 12:00:00-05' from public.billing_subscriptions where tenant_id='$T4')"
setclock '2026-01-20 12:00:00-05'
B3="$(SUBROW $T3)"; PAY $T3 2026-12-31; PAY $T6 2026-12-31; PAY $T7 2026-12-31; PAY $T8 2026-12-31
chk "C3 primer pago PENDING_PAYMENT con periodo fijado: ACTIVE, periodo intacto [01-01, 02-01]" \
  "$(S $T3 "status='ACTIVE' and current_period_start='2026-01-01 00:00:00-05' and current_period_end='2026-02-01 00:00:00-05'")"
chk "C5 PAST_DUE paga: ACTIVE, periodo intacto" \
  "$(S $T7 "status='ACTIVE' and current_period_start='2026-01-01 00:00:00-05' and current_period_end='2026-02-01 00:00:00-05'")"
chk "C6 CANCELLED paga: sigue CANCELLED, periodo intacto" \
  "$(S $T6 "status='CANCELLED' and current_period_end='2026-02-01 00:00:00-05'")"
chk "C7 EXPIRED paga: sigue EXPIRED, periodo intacto" \
  "$(S $T8 "status='EXPIRED' and current_period_end='2026-02-01 00:00:00-05'")"
chk "C8 la factura inicial de T1/T2 sigue sin pagar (control)" \
  "(select count(*)=2 from public.payment_invoices where payer_tenant_id in ('$T1','$T2') and status='PENDING')"

echo "== 6 ciclos mensuales (T1 paga a tiempo, T2 paga tarde dentro de la gracia, T3/T4 primer pago ya hecho)"
for k in 1 2 3 4 5 6; do
  # el periodo vigente termina el 1/(k+1); el cron corre 3 dias antes
  DUE=$($P -c "select ('2026-01-01'::date + interval '$k months')::date")
  PRE=$($P -c "select ('$DUE'::date - 3)")
  setclock "$PRE 07:00:00-05"; crons; crons
  EXP=$($P -c "select ('2026-01-01 00:00:00-05'::timestamptz + interval '$((k+1)) months')")
  EXPS=$($P -c "select ('2026-01-01 00:00:00-05'::timestamptz + interval '$k months')")
  # T4 (legado) corre con otra fecha de periodo: solo se verifica su conteo
  chk "L$k.1 tras el cron del ciclo $k: T1/T2/T3 tienen $((k+1)) facturas y periodo [$EXPS, $EXP]" \
    "(select count(*)=3 and bool_and(n=$((k+1)) and ps='$EXPS' and pe='$EXP' and st='ACTIVE') from (select s.tenant_id, s.status st, s.current_period_start ps, s.current_period_end pe, (select count(*) from public.payment_invoices i where i.subscription_id=s.id and i.deleted_at is null) n from public.billing_subscriptions s where s.tenant_id in ('$T1','$T2','$T3')) z)"
  setclock "$DUE 10:00:00-05"; crons
  PAY $T1 $DUE; PAY $T3 $DUE
  setclock "$($P -c "select ('$DUE'::date + 1)") 10:00:00-05"; crons
  setclock "$($P -c "select ('$DUE'::date + 2)") 10:00:00-05"; crons
  PAY $T2 "$DUE"; crons
  chk "L$k.2 tras los pagos del ciclo $k el periodo no se movio y nada esta OVERDUE (T1/T2/T3)" \
    "(select count(*)=3 and bool_and(pe='$EXP' and st='ACTIVE') from (select s.status st, s.current_period_end pe from public.billing_subscriptions s where s.tenant_id in ('$T1','$T2','$T3')) z) and not exists (select 1 from public.payment_invoices where payer_tenant_id in ('$T1','$T2','$T3') and status='OVERDUE')"
done
chk "L7 T1/T2/T3: 7 facturas con vencimientos consecutivos 02-01..08-01, ninguna salteada ni duplicada" \
  "(select bool_and(a = array['2026-02-01','2026-03-01','2026-04-01','2026-05-01','2026-06-01','2026-07-01','2026-08-01']::date[]) from (select array_agg(i.due_date order by i.due_date) a from public.payment_invoices i where i.payer_tenant_id in ('$T1','$T2','$T3') and i.deleted_at is null group by i.payer_tenant_id) z)"
chk "L8 T1/T2/T3 siguen activos y solo la ultima factura (08-01) queda pendiente" \
  "(select count(*)=3 and bool_and(status='active') from public.tenants where id in ('$T1','$T2','$T3')) and (select count(*)=3 and bool_and(due_date='2026-08-01') from public.payment_invoices where payer_tenant_id in ('$T1','$T2','$T3') and status='PENDING')"
chk "L9 T2 (pago tardio) sin facturas OVERDUE ni duplicadas, 7 facturas, 6 PAID" \
  "(select count(*)=7 and count(*) filter (where status='PAID')=6 from public.payment_invoices where payer_tenant_id='$T2')"

echo "== idempotencia (caso 6)"
BEFORE_ROW=$($P -c "select md5(s::text) from public.billing_subscriptions s where tenant_id='$T1'")
$P -c "update public.payment_invoices set status='PAID' where payer_tenant_id='$T1' and status='PAID'" >/dev/null
chk "I1 marcar PAID una factura ya PAID no mueve nada" "(select md5(s::text)='$BEFORE_ROW' from public.billing_subscriptions s where tenant_id='$T1')"
$P -c "update public.payment_invoices set status='PENDING' where payer_tenant_id='$T1' and status='PAID' and due_date='2026-07-01';
       update public.payment_invoices set status='PAID' where payer_tenant_id='$T1' and status='PENDING' and due_date='2026-07-01'" >/dev/null
chk "I2 reabrir y volver a pagar una factura no mueve el periodo" "(select md5(s::text)='$BEFORE_ROW' from public.billing_subscriptions s where tenant_id='$T1')"

echo "== plan anual (caso 5)"
setclock '2026-12-29 07:00:00-05'; crons; crons
chk "Y1 cron del 2026-12-29 avanza el anual 1 anio: [2027-01-01, 2028-01-01] y 1 sola factura nueva (due 2028-01-01)" \
  "$(S $T5 "current_period_start='2027-01-01 00:00:00-05' and current_period_end='2028-01-01 00:00:00-05'") and (select count(*)=2 and count(*) filter (where due_date='2028-01-01')=1 from public.payment_invoices where payer_tenant_id='$T5')"
setclock '2027-01-01 10:00:00-05'; PAY $T5 2027-01-01; crons
chk "Y2 el pago de la factura anual no mueve el periodo ni genera facturas" \
  "$(S $T5 "status='ACTIVE' and current_period_start='2027-01-01 00:00:00-05' and current_period_end='2028-01-01 00:00:00-05'") and (select count(*)=2 from public.payment_invoices where payer_tenant_id='$T5')"

echo "== otras tablas (caso 7)"
fp after
chk "H1 planes, modulos de plan, modulos habilitados y modulos pactados sin cambios (huellas md5)" \
  "$(fpv setup plans h)=$(fpv after plans h) and $(fpv setup plan_modules h)=$(fpv after plan_modules h) and $(fpv setup tem h)=$(fpv after tem h) and $(fpv setup sub_modules h)=$(fpv after sub_modules h)"

# Mutaciones: cada una debe hacer fallar la prueba (exit 1). NO_MUT evita recursion.
if [ -z "${NO_MUT:-}" ] && [ -z "${OLD_TRIGGER:-}" ]; then
  echo "== mutaciones"
  NO_MUT=1 OLD_TRIGGER=1 PGPORT_TEST=54382 "$0" > "$WORK/m1.out" 2>&1; rc=$?
  echo "   M1 trigger previo restaurado -> exit $rc: $(grep RESUMEN "$WORK/m1.out")"
  grep -E '^FAIL' "$WORK/m1.out" | head -5 | sed 's/^/      /'
  chk "M1 con el trigger viejo la prueba falla (exit 1)" "$([ $rc -eq 1 ] && echo true || echo false)"
  sed "s/and status in ('PENDING_PAYMENT', 'PAST_DUE');/and true;/" "$NEW" > "$WORK/mut2.sql"
  if cmp -s "$WORK/mut2.sql" "$NEW"; then chk "M2 la mutacion se aplico" false
  else
    NO_MUT=1 MIG_OVERRIDE="$WORK/mut2.sql" PGPORT_TEST=54383 "$0" > "$WORK/m2.out" 2>&1; rc=$?
    echo "   M2 sin filtro de estado (reactiva CANCELLED/EXPIRED) -> exit $rc: $(grep RESUMEN "$WORK/m2.out")"
    chk "M2 sin filtro de estado la prueba falla (exit 1)" "$([ $rc -eq 1 ] && echo true || echo false)"
  fi
  sed "s/then now() + coalesce(v_interval, interval '1 month') else current_period_end end/then current_period_end end/" "$NEW" > "$WORK/mut3.sql"
  if cmp -s "$WORK/mut3.sql" "$NEW"; then chk "M3 la mutacion se aplico" false
  else
    NO_MUT=1 MIG_OVERRIDE="$WORK/mut3.sql" PGPORT_TEST=54384 "$0" > "$WORK/m3.out" 2>&1; rc=$?
    echo "   M3 legado sin fijar fin de periodo -> exit $rc: $(grep RESUMEN "$WORK/m3.out")"
    chk "M3 sin el caso legado la prueba falla (exit 1)" "$([ $rc -eq 1 ] && echo true || echo false)"
  fi
fi

NPASS=$($P -c "select count(*) from r.results where ok")
NFAIL=$($P -c "select count(*) from r.results where not ok")
echo "RESUMEN $NPASS PASS, $NFAIL FAIL"
if [ "$NFAIL" -ne 0 ] || [ "$NPASS" -eq 0 ]; then exit 1; fi
exit 0
