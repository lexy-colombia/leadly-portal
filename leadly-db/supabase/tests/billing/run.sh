#!/usr/bin/env bash
# Prueba las migraciones de cobro anticipado + bloqueo por mora (20261020130000/140000/150000) en un
# Postgres 15 DESCARTABLE (NO toca ninguna base real). Aplica las migraciones REALES de billing
# (misma cadena que tests/period_advance_fix) y simula el tiempo con un reloj falso.
# Uso: tests/billing/run.sh  -> "RESUMEN N PASS, M FAIL"; exit != 0 ante cualquier fallo.
# Variables: PGTZ (huso de la sesion, defecto America/Bogota), MIG_A/MIG_B/MIG_C/MIG_D/MIG_E (migraciones a probar),
#            NO_MUT=1 (omite las mutaciones; evita recursion).
set -uo pipefail
PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@15/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
BAR="$HERE/../barriles_subscription"
MIGS="$HERE/../../migrations"
MIG_A=${MIG_A:-$MIGS/20261020130000_billing_invoice_periods.sql}
MIG_B=${MIG_B:-$MIGS/20261020140000_billing_cycle_prepaid.sql}
MIG_C=${MIG_C:-$MIGS/20261020150000_tenant_suspension_nonpayment.sql}
MIG_D=${MIG_D:-$MIGS/20261020160000_nonpayment_tenant_reads_own_invoices.sql}
MIG_E=${MIG_E:-$MIGS/20261020170000_barriles_prepaid_due_date.sql}
WORK=$(mktemp -d); PORT=${PGPORT_TEST:-54391}
export PGHOST=127.0.0.1 PGPORT=$PORT PGUSER=postgres PGDATABASE=postgres PGTZ=${PGTZ:-America/Bogota}
"$PGBIN/initdb" -D "$WORK/data" -U postgres --auth=trust >/dev/null || exit 2
"$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$WORK" -l "$WORK/pg.log" -w start >/dev/null || exit 2
cleanup() { "$PGBIN/pg_ctl" -D "$WORK/data" -m fast stop >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
PSQL="$PGBIN/psql -X -q -t -A"
LOG="$WORK/assertions.log"; : > "$LOG"
SETUP_FAIL=0
die() { echo "FAIL  (preparacion: $1)" | tee -a "$LOG"; SETUP_FAIL=1; summary; }
summary() {
  local np nf; np=$(grep -c '^PASS' "$LOG" || true); nf=$(grep -c '^FAIL' "$LOG" || true)
  echo "RESUMEN $np PASS, $nf FAIL"
  if [ "$nf" -ne 0 ] || [ "$np" -eq 0 ]; then exit 1; fi
  exit 0
}
sqlf() { local db=$1; shift; PGDATABASE=$db PGOPTIONS='-c client_min_messages=warning' $PSQL -v ON_ERROR_STOP=1 -f "$1" > "$WORK/out.txt" 2>&1; local rc=$?; [ $rc -ne 0 ] && { cat "$WORK/out.txt" | tail -5; return $rc; }; return 0; }
mkdb() { $PSQL -d postgres -c "drop database if exists $1" -c "create database $1 template $2" >/dev/null || die "createdb $1"; }
report() { # db etiqueta
  echo "== $2"
  PGDATABASE=$1 $PSQL -c "select case when ok then 'PASS  ' else 'FAIL  ' end || name || case when ok then '' else '  -- ' || coalesce(detail, '') end from t.results order by n" | tee -a "$LOG"
}
runtests() { # db archivo etiqueta
  PGDATABASE=$1 PGOPTIONS='-c client_min_messages=warning' $PSQL -v ON_ERROR_STOP=1 -f "$2" > "$WORK/out_${3%%.*}.txt" 2>&1; local rc=$?
  report "$1" "$3"
  if [ $rc -ne 0 ]; then echo "FAIL  ($3: psql aborto rc=$rc) $(grep -E 'ERROR|FATAL' "$WORK/out_${3%%.*}.txt" | head -2 | tr '\n' ' ')" | tee -a "$LOG"; fi
}
patchclock() { # db: reloj falso en todas las funciones que usan now()/current_date
  local db=$1
  PGDATABASE=$db $PSQL -c "create table public.zz_clock(now timestamptz); insert into public.zz_clock values ('2026-01-01 08:00:00-05');
    create function public.zz_now() returns timestamptz language sql stable as \$\$ select now from public.zz_clock \$\$;" >/dev/null || die "reloj"
  for sig in 'create_invoice_for_subscription(uuid,date)' 'process_recurring_billing_invoices()' 'deactivate_tenants_with_overdue_invoices()' \
             'mark_overdue_invoices()' 'tenant_has_blocking_invoice(uuid)' 'cancel_subscription(uuid)' 'annul_future_invoices(uuid)' \
             'activate_subscription_on_invoice_paid()' 'billing_subscriptions_set_initial_period()'; do
    PGDATABASE=$db $PSQL -c "select pg_get_functiondef('public.$sig'::regprocedure)" > "$WORK/fn.sql" || die "def $sig"
    sed -i '' -e 's/now()/public.zz_now()/g' -e 's/current_date/public.zz_now()::date/g' "$WORK/fn.sql"
    grep -q zz_now "$WORK/fn.sql" || die "parche sin efecto en $sig"
    PGDATABASE=$db PGOPTIONS='-c client_min_messages=warning' $PSQL -v ON_ERROR_STOP=1 -f "$WORK/fn.sql" >/dev/null || die "parche $sig"
  done
  sqlf "$db" "$HERE/02_clock_helpers.sql" || die "02_clock_helpers"
}

# ---------------------------------------------------------------- base (esquema real de billing, SIN las migraciones nuevas)
$PSQL -d postgres -c "create database b0" >/dev/null || die "createdb b0"
sqlf b0 "$BAR/00_stubs.sql" || die "stubs"
sqlf b0 "$HERE/00_auth_stubs.sql" || die "auth stubs"
for f in 20260807173542_billing_plans 20260807173551_billing_subscriptions 20260807173601_payment_invoices \
         20260807173612_payment_attempts 20260807173621_billing_subscription_activation 20260807173632_recurring_billing_cron \
         20260811000001_tenant_modules; do sqlf b0 "$MIGS/$f.sql" || die "$f"; done
sed -n '/drop constraint if exists tenant_enabled_modules_module_key_check/,/\]));/p' "$MIGS/20260913210000_channels_module_and_permissions.sql" > "$WORK/check.sql"
sqlf b0 "$WORK/check.sql" || die "check module_key vigente"
for f in 20260811000004_payment_invoices_dian_fields 20260811000005_manual_payments 20260811000006_billing_plans_max_users \
         20260811000007_billing_plans_max_whatsapp_lines 20260811000008_payment_invoice_items \
         20260811000009_billing_subscriptions_initial_invoice 20260811000010_billing_subscriptions_cancel_at_period_end \
         20260811000011_billing_unify_invoice_creation 20260811000012_billing_auto_deactivate_overdue_tenants; do
  sqlf b0 "$MIGS/$f.sql" || die "$f"; done
awk '/Patrón A/{f=1} f{print} f&&/^end \$\$;/{exit}' "$MIGS/20260822000001_perf_security_hardening.sql" > "$WORK/hardening.sql"
sqlf b0 "$WORK/hardening.sql" || die "hardening policies"
for f in 20261013130000_plans_entitlements 20261013140000_billing_functions_revoke_public 20261013180000_subscription_period_single_advance; do
  sqlf b0 "$MIGS/$f.sql" || die "$f"; done
# guard de escalada tal cual esta en produccion (20260816030001: funcion + trigger; sin la policy)
sed -n '/^create or replace function public.prevent_tenant_self_service_escalation/,$p' "$MIGS/20260816030001_tenants_self_service_update.sql" > "$WORK/guard_old.sql"
sqlf b0 "$WORK/guard_old.sql" || die "guard vigente"
sqlf b0 "$HERE/01_helpers.sql" || die "helpers"

# ---------------------------------------------------------------- 1. CODIGO VIGENTE: los defectos
mkdb bpre b0
runtests bpre "$HERE/10_regression_old.sql" "1. Codigo vigente (sin migraciones nuevas): defectos reproducidos"

# ---------------------------------------------------------------- 2. backfill sobre la forma de produccion + simulacion
mkdb bfix b0
sqlf bfix "$HERE/05_prod_fixture.sql" || die "fixture de produccion"
HASHQ="select md5(string_agg(id::text || coalesce(period_start::text,'-') || coalesce(period_end::text,'-') || due_date::text || status, '|' order by id)) from public.payment_invoices"
H0=$(PGDATABASE=bfix $PSQL -c "select count(*) from public.payment_invoices")
echo "== migraciones nuevas sobre el estado de produccion ($H0 comprobantes antes)"
for m in "$MIG_A" "$MIG_B" "$MIG_C" "$MIG_D"; do sqlf bfix "$m" || die "migracion $(basename "$m")"; done
HA=$(PGDATABASE=bfix $PSQL -c "$HASHQ")
RC=0; for m in "$MIG_A" "$MIG_B" "$MIG_C" "$MIG_D"; do sqlf bfix "$m" || RC=1; done
HB=$(PGDATABASE=bfix $PSQL -c "$HASHQ")
{ [ "$RC" -eq 0 ] && echo "PASS  I1 las 3 migraciones son idempotentes (2a aplicacion rc=0)" || echo "FAIL  I1 la 2a aplicacion fallo"; } | tee -a "$LOG"
{ [ "$HA" = "$HB" ] && echo "PASS  I2 la 2a aplicacion no cambia los comprobantes (huella md5 identica)" || echo "FAIL  I2 la huella cambio"; } | tee -a "$LOG"
runtests bfix "$HERE/20_backfill.sql" "2. Backfill (D1) sobre la forma real de produccion"
patchclock bfix
runtests bfix "$HERE/60_sim.sql" "3. Simulacion del tiempo con Barriles y Faiver (2026-10-20 a 2027-03-05)"
NW=$(grep -c 'omitida' "$WORK/out_3.txt" || true)
{ [ "${NW:-0}" -eq 0 ] && echo "PASS  S15 la simulacion no emitio ningun WARNING 'omitida' del cron (ninguna suscripcion fallo)" || echo "FAIL  S15 $NW warnings 'omitida' en la simulacion"; } | tee -a "$LOG"

# ---------------------------------------------------------------- 3. funcionales sobre base limpia
mkdb bnew b0
for m in "$MIG_A" "$MIG_B" "$MIG_C" "$MIG_D"; do sqlf bnew "$m" || die "migracion $(basename "$m")"; done
patchclock bnew
mkdb bcreate bnew; sqlf bcreate "$HERE/03_plans_fixture.sql" || die "plans fixture"
runtests bcreate "$HERE/30_creation.sql" "4. Creacion de comprobantes (D2)"
mkdb bcycle bnew; sqlf bcycle "$HERE/03_plans_fixture.sql" || die "plans fixture"
runtests bcycle "$HERE/40_cycle.sql" "5. Ciclo en dos pasos (D3)"
NW=$(grep -c 'omitida' "$WORK/out_5.txt" || true)
{ [ "${NW:-0}" -eq 0 ] && echo "PASS  C12 el recorrido de 367 dias no emitio ningun WARNING 'omitida' del cron" || echo "FAIL  C12 $NW warnings 'omitida'"; } | tee -a "$LOG"
mkdb bcancel bnew; sqlf bcancel "$HERE/03_plans_fixture.sql" || die "plans fixture"
runtests bcancel "$HERE/45_cancel.sql" "5b. Cancelacion anula comprobantes futuros (H1)"
mkdb bwompi bnew
# apply_wompi_invoice_payment REAL (20261016130000); tabla externa simulada: sales_order_payments (solo se consulta)
awk '/^create or replace function public.apply_wompi_invoice_payment/{f=1} f{print} f&&/^\$\$;/{exit}' "$MIGS/20261016130000_wompi_internal_apply_functions.sql" > "$WORK/wompi_fn.sql"
[ -s "$WORK/wompi_fn.sql" ] || die "no se extrajo apply_wompi_invoice_payment"
PGDATABASE=bwompi $PSQL -c "create table public.sales_order_payments(provider_key text, provider_transaction_id text, deleted_at timestamptz); alter table public.payment_invoices add column if not exists provider_transaction_id text;
  create unique index if not exists zz_inv_tx_uidx on public.payment_invoices(provider_transaction_id) where provider_transaction_id is not null;" >/dev/null 2>&1
sqlf bwompi "$WORK/wompi_fn.sql" || die "apply_wompi_invoice_payment"
PGDATABASE=bwompi $PSQL -c "revoke all on function public.apply_wompi_invoice_payment(uuid,uuid,text,bigint,bigint,text,jsonb) from public, anon, authenticated; grant execute on function public.apply_wompi_invoice_payment(uuid,uuid,text,bigint,bigint,text,jsonb) to service_role;" >/dev/null
runtests bwompi "$HERE/55_wompi.sql" "6b. apply_wompi_invoice_payment real + trigger de reactivacion (H6)"
mkdb bwall bnew
runtests bwall "$HERE/70_wall.sql" "7. Muro de pago: lectura del tenant bloqueado por mora (D7 / ST3)"

# ---------------------------------------------------------------- 8. ST4: migracion de DATOS de Barriles (forma real: Barriles + Faiver)
mkdb bst4 b0
sqlf bst4 "$HERE/05_prod_fixture.sql" || die "fixture st4"
for m in "$MIG_A" "$MIG_B" "$MIG_C" "$MIG_D"; do sqlf bst4 "$m" || die "st4 $(basename "$m")"; done
patchclock bst4
PGDATABASE=bst4 $PSQL -c "select t.setclock('2026-10-20 08:00:00-05')" >/dev/null
PRE_SQL="create table t.pre(k text primary key, v text); grant all on t.pre to public;
  insert into t.pre select 'rest', md5(coalesce(string_agg(id::text || period_start::text || period_end::text || due_date::text || status || coalesce(deleted_at::text,'-'), '|' order by id), '')) from public.payment_invoices where id <> '5851bd75-6fd7-4ae8-bae6-f2ec705e9010';
  insert into t.pre select 'sub', md5(string_agg(id::text || status || current_period_start::text || current_period_end::text || cancel_at_period_end::text, '|' order by id)) from public.billing_subscriptions;"
INVQ="select due_date::text || '/' || status from public.payment_invoices where id = '5851bd75-6fd7-4ae8-bae6-f2ec705e9010'"
st4case() { # id descripcion sql-de-preparacion esperado(abort|noop) due-esperado
  local id=$1 desc=$2 prep=$3 exp=$4 due=$5
  local db="bst4_$(echo "$id" | tr A-Z a-z)"
  mkdb "$db" bst4
  [ -n "$prep" ] && { PGDATABASE=$db $PSQL -c "set session_replication_role = replica; $prep" >"$WORK/prep_$id.txt" 2>&1 || { echo "FAIL  $id la preparacion fallo: $(head -c 200 "$WORK/prep_$id.txt")" | tee -a "$LOG"; return; }; }
  PGDATABASE=$db PGOPTIONS='-c client_min_messages=notice' $PSQL -v ON_ERROR_STOP=1 -f "$MIG_E" > "$WORK/st4_$id.txt" 2>&1; local rc=$?
  local got; got=$(PGDATABASE=$db $PSQL -c "$INVQ")
  if [ "$exp" = abort ]; then
    { [ $rc -ne 0 ] && grep -q 'barriles_prepaid_due_date' "$WORK/st4_$id.txt" && [ "$got" = "$due" ] && echo "PASS  $id $desc: ABORTA y no cambia nada ($got)" || echo "FAIL  $id $desc: rc=$rc got=$got"; } | tee -a "$LOG"
  else
    { [ $rc -eq 0 ] && grep -q 'no-op' "$WORK/st4_$id.txt" && [ "$got" = "$due" ] && echo "PASS  $id $desc: no-op con NOTICE ($got)" || echo "FAIL  $id $desc: rc=$rc got=$got"; } | tee -a "$LOG"
  fi
}
INV="id = '5851bd75-6fd7-4ae8-bae6-f2ec705e9010'"
st4case N1 "comprobante ya PAID" "update public.payment_invoices set status='PAID' where $INV" abort "2026-11-10/PAID"
st4case N2 "monto distinto" "update public.payment_invoices set amount_cents=14000001 where $INV" abort "2026-11-10/PENDING"
st4case N3 "anulado (deleted_at)" "update public.payment_invoices set deleted_at=now() where $INV" abort "2026-11-10/PENDING"
st4case N4 "due_date inesperado" "update public.payment_invoices set due_date='2026-11-11' where $INV" abort "2026-11-11/PENDING"
st4case N5 "suscripcion CANCELLED" "update public.billing_subscriptions set status='CANCELLED' where id='b0b0b0b0-0000-4000-8000-000000000001'" abort "2026-11-10/PENDING"
st4case N6 "periodo distinto" "update public.payment_invoices set period_end='2026-11-11' where $INV" abort "2026-11-10/PENDING"
st4case N7 "comprobante de otro tenant" "update public.payment_invoices set payer_tenant_id=(select id from public.tenants where name like 'Faiver%') where $INV" abort "2026-11-10/PENDING"
st4case N8 "periodo de la suscripcion distinto" "update public.billing_subscriptions set current_period_end=current_period_end + interval '1 day' where id='b0b0b0b0-0000-4000-8000-000000000001'" abort "2026-11-10/PENDING"
st4case N9 "el comprobante no existe" "delete from public.payment_invoice_items where invoice_id='5851bd75-6fd7-4ae8-bae6-f2ec705e9010'; delete from public.payment_invoices where $INV" noop ""
st4case N10 "ya vence 2026-10-10" "update public.payment_invoices set due_date='2026-10-10' where $INV" noop "2026-10-10/PENDING"
# camino feliz + simulacion
PGDATABASE=bst4 $PSQL -c "$PRE_SQL" >/dev/null || die "pre st4"
sqlf bst4 "$MIG_E" || die "aplicar ST4"
RC=0; sqlf bst4 "$MIG_E" || RC=1
{ [ $RC -eq 0 ] && [ "$(PGDATABASE=bst4 $PSQL -c "$INVQ")" = "2026-10-10/PENDING" ] && echo "PASS  I3 la migracion de datos es idempotente (2a aplicacion rc=0, sin cambios)" || echo "FAIL  I3 idempotencia"; } | tee -a "$LOG"
runtests bst4 "$HERE/80_barriles_due.sql" "8. ST4: comprobante de Barriles vence 10-oct; mora -> pago -> reactivacion (forma real)"
mkdb bmora bnew
runtests bmora "$HERE/50_mora.sql" "6. Mora, reactivacion, guard y privilegios (D4/D5/D6)"
WN=$(grep -c "no se pudo reactivar" "$WORK/out_6.txt" || true)
{ [ "${WN:-0}" -ge 1 ] && echo "PASS  R5c el fallo simulado de la reactivacion emitio el WARNING ($WN)" || echo "FAIL  R5c no se emitio el WARNING"; } | tee -a "$LOG"

# ---------------------------------------------------------------- mutaciones: cada una DEBE hacer fallar la prueba
if [ -z "${NO_MUT:-}" ]; then
  echo "== mutaciones (cada una debe terminar con exit 1)"
  mut() { # id descripcion archivo-origen sed-expr variable puerto
    local id=$1 desc=$2 src=$3 expr=$4 var=$5 port=$6
    sed "$expr" "$src" > "$WORK/mut_$id.sql"
    if cmp -s "$WORK/mut_$id.sql" "$src"; then echo "FAIL  $id la mutacion no se aplico ($desc)" | tee -a "$LOG"; return; fi
    env NO_MUT=1 PGPORT_TEST=$port "$var=$WORK/mut_$id.sql" "$0" > "$WORK/mut_$id.out" 2>&1; local rc=$?
    echo "   $id $desc -> exit $rc: $(grep RESUMEN "$WORK/mut_$id.out") | primeros FAIL: $(grep -E '^FAIL' "$WORK/mut_$id.out" | head -2 | cut -c1-110 | tr '\n' ';')"
    [ $rc -eq 1 ] && echo "PASS  $id la prueba detecta la mutacion ($desc)" | tee -a "$LOG" || echo "FAIL  $id la prueba NO detecto la mutacion ($desc)" | tee -a "$LOG"
  }
  mut M1 "guard SIN el arreglo (solo is_superadmin)" "$MIG_C" "s/coalesce(auth.role(), '') not in ('anon', 'authenticated')/false/" MIG_C 54392
  mut M2 "adelanto de 3 dias en vez de 7" "$MIG_B" "s/interval '7 days'/interval '3 days'/" MIG_B 54393
  mut M3 "trigger de reactivacion al pagar nunca dispara" "$MIG_C" "s/after update of status on public.payment_invoices/after update of provider_payment_data on public.payment_invoices/" MIG_C 54394
  mut M4 "backfill de periodos desactivado" "$MIG_A" "s/and pi.period_start is null;/and false;/" MIG_A 54395
  mut M5 "vencimiento al FIN del periodo (semantica vieja)" "$MIG_A" "s/v_due := case when v_first then now()::date else greatest(v_pstart, now()::date) end;/v_due := v_sub.current_period_end::date;/" MIG_A 54396
  mut M7 "guard sin proteger suspension_reason/suspended_at" "$MIG_C" "/new.suspension_reason is distinct from old.suspension_reason/d;/new.suspended_at is distinct from old.suspended_at/d" MIG_C 54398
  mut M8 "cancel_subscription sin anular futuros (H1)" "$MIG_B" "/-- H1\$/d" MIG_B 54399
  mut M9 "paso CANCEL del cron sin anular futuros (H1)" "$MIG_B" "/-- H1-cron\$/d" MIG_B 54400
  mut M10 "muro: la politica NO exige el motivo (cualquier inactivo lee)" "$MIG_D" "s/and t.suspension_reason = 'nonpayment';/;/" MIG_D 54401
  mut M11 "muro: la politica de comprobantes no filtra por tenant (lee todo)" "$MIG_D" "s/using (payer_tenant_id = (select public.auth_nonpayment_tenant_id()));/using (true);/" MIG_D 54402
  mut M12 "muro: items sin vinculo al comprobante ni al tenant (exists trivial)" "$MIG_D" "/payment_invoice_items_select_nonpayment/,/);/{s/where i.id = payment_invoice_items.invoice_id/where true/;s/and i.payer_tenant_id = (select public.auth_nonpayment_tenant_id())/and true/;}" MIG_D 54403
  mut M13 "ST4: fija una fecha equivocada" "$MIG_E" "s/set due_date = date '2026-10-10'/set due_date = date '2026-10-11'/" MIG_E 54404
  mut M14 "ST4: sin guarda de monto" "$MIG_E" "/or v_inv.amount_cents <> 14000000/d" MIG_E 54405
  mut M6 "bloqueo sin motivo (suspension_reason no se guarda)" "$MIG_C" "s/      suspension_reason = 'nonpayment',//" MIG_C 54397
fi
summary
