#!/usr/bin/env bash
# Prueba las migraciones F1/S1 (client_billing_profiles, columnas de pedidos, guard/efectos,
# dedupe de direcciones, candado) en un Postgres 15 DESCARTABLE (no toca ninguna base real).
# Reconstruye el esquema REAL repitiendo TODAS las migraciones previas (menos las 20261105*, ajenas)
# sobre un esqueleto minimo de Supabase (00_stubs.sql). Las migraciones de datos propios de un tenant
# de produccion fallan a proposito (no existe ese tenant): se ignoran, igual que en un entorno limpio.
# Uso: tests/billing_profiles/run.sh  -> "RESUMEN N PASS, M FAIL"; exit != 0 ante cualquier fallo.
# Variables: NO_MUT=1 omite mutaciones; MIGDIR para probar migraciones mutadas.
set -uo pipefail
PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@15/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
MIGS=${MIGDIR:-$HERE/../../migrations}
REALMIGS=$HERE/../../migrations
FIRST_S1=20261112120000
WORK=$(mktemp -d); PORT=${PGPORT_TEST:-54431}
SOCK=$(mktemp -d /tmp/bpXXXXXX)
export PGHOST=127.0.0.1 PGPORT=$PORT PGUSER=postgres
"$PGBIN/initdb" -D "$WORK/data" -U postgres --auth=trust >/dev/null || exit 2
"$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$SOCK" -l "$WORK/pg.log" -w start >/dev/null || exit 2
cleanup() { "$PGBIN/pg_ctl" -D "$WORK/data" -m fast stop >/dev/null 2>&1; rm -rf "$WORK" "$SOCK"; }
trap cleanup EXIT
PSQL="$PGBIN/psql -X -q -t -A"
LOG="$WORK/assertions.log"; : > "$LOG"
summary() {
  local np nf; np=$(grep -c '^PASS' "$LOG" || true); nf=$(grep -c '^FAIL' "$LOG" || true)
  echo "RESUMEN $np PASS, $nf FAIL"
  if [ "$nf" -ne 0 ] || [ "$np" -eq 0 ]; then exit 1; fi
  exit 0
}
die() { echo "FAIL  (preparacion: $1)" | tee -a "$LOG"; summary; }
sqlf() { local db=$1; shift; PGDATABASE=$db PGOPTIONS='-c client_min_messages=notice' $PSQL -v ON_ERROR_STOP=1 -f "$1" > "$WORK/out.txt" 2>&1; local rc=$?; [ $rc -ne 0 ] && { tail -5 "$WORK/out.txt"; return $rc; }; return 0; }
mkdb() { $PSQL -d postgres -c "drop database if exists $1" -c "create database $1 template $2" >/dev/null || die "createdb $1"; }
report() { echo "== $2"; PGDATABASE=$1 $PSQL -c "select case when ok then 'PASS  ' else 'FAIL  ' end || name || case when ok then '' else '  -- ' || coalesce(detail, '') end from t.results order by n" | tee -a "$LOG"; }
runtests() { # db archivo etiqueta
  PGDATABASE=$1 PGOPTIONS='-c client_min_messages=warning' $PSQL -v ON_ERROR_STOP=1 -v MIGS="$MIGS" -f "$2" > "$WORK/out_t.txt" 2>&1; local rc=$?
  report "$1" "$3"
  [ $rc -ne 0 ] && echo "FAIL  ($3: psql aborto rc=$rc) $(grep -E 'ERROR|FATAL' "$WORK/out_t.txt" | head -2 | tr '\n' ' ')" | tee -a "$LOG"
}
apply_s1() { # db  (aplica las 6 migraciones S1 desde $MIGS, cada una en una transaccion, como db push)
  local db=$1
  for f in $(ls "$MIGS"/${FIRST_S1:0:8}*.sql 2>/dev/null | sort); do
    PGDATABASE=$db PGOPTIONS='-c client_min_messages=notice' $PSQL -v ON_ERROR_STOP=1 --single-transaction -f "$f" > "$WORK/s1_$(basename "$f").txt" 2>&1 || { tail -4 "$WORK/s1_$(basename "$f").txt"; return 1; }
  done
}

# ---------------- 1. linea base: esquema real previo a S1
$PSQL -d postgres -c "create database base" >/dev/null || die "createdb base"
PGDATABASE=base $PSQL -f "$HERE/00_stubs.sql" >/dev/null 2>&1
for f in $(ls "$REALMIGS"/*.sql | sort); do
  b=$(basename "$f")
  case "$b" in 20261105*) continue;; esac
  [[ "$b" > "$FIRST_S1" || "$b" == "$FIRST_S1"* ]] && break
  PGDATABASE=base PGOPTIONS='-c client_min_messages=error' $PSQL -v ON_ERROR_STOP=1 --single-transaction -f "$f" >/dev/null 2>&1 || true
done
# delivery_status existe en produccion (lo usa el trigger de despachos) pero ninguna migracion lo crea: se anade.
$PSQL -d base -c "alter table public.sales_orders add column if not exists delivery_status text default 'pendiente'" >/dev/null
n=$($PSQL -d base -c "select count(*) from information_schema.tables where table_schema='public' and table_name in ('clients','contact_addresses','carts','sales_orders','sales_invoices','cities','document_types')")
[ "$n" = "7" ] || die "linea base incompleta ($n/7 tablas)"
# la linea base NO tiene aun client_billing_profiles
[ "$($PSQL -d base -c "select to_regclass('public.client_billing_profiles') is null")" = "t" ] || die "la linea base ya tiene S1"
sqlf base "$HERE/05_prod_fixture.sql" || die "fixture"

# ---------------- 2. aplicar S1 sobre los datos previos
mkdb bs0 base
apply_s1 bs0 || die "aplicar migraciones S1"
grep -h "backfill:\|dedupe:" "$WORK"/s1_*.txt | sed 's/^/   /'
sqlf bs0 "$HERE/10_helpers.sql" || die "helpers"
mkdb bs1 bs0
runtests bs1 "$HERE/20_backfill.sql" "1. Backfill desde clients"
mkdb bs2 bs0
runtests bs2 "$HERE/30_schema.sql" "2. Esquema, RLS y RPC de perfiles"
mkdb bs3 bs0
runtests bs3 "$HERE/40_orders.sql" "3. Pedidos y carritos: columnas, FK, save_cart_lines"
mkdb bs4 bs0
runtests bs4 "$HERE/50_guard_effects.sql" "4. guard_sales_order_confirmation y apply_sales_order_confirmed_effects"
mkdb bs5 bs0
runtests bs5 "$HERE/60_lock.sql" "5. Candado orden facturada (comprador y destino)"
mkdb bs6 bs0
runtests bs6 "$HERE/65_dedupe.sql" "6. Dedupe de direcciones"

mkdb bs8 bs0
runtests bs8 "$HERE/80_round2.sql" "8. Ronda 2: walk-in sin perfiles ni correo de la ficha, correccion de destino atomica"

# ---------------- 3. violaciones preexistentes (shipping de otro cliente) y re-ejecucion
mkdb bv base
PGDATABASE=bv $PSQL -c "insert into public.sales_orders(tenant_id, contact_id, shipping_address_id) values (t.id('A'), t.id('c_other'), t.id('a_ship'))" >/dev/null || die "violacion previa"
apply_s1 bv || die "aplicar S1 con violaciones"
sqlf bv "$HERE/10_helpers.sql" || die "helpers bv"
runtests bv "$HERE/70_preexisting_violation.sql" "7. Inconsistencias preexistentes: no abortan y lo nuevo se valida"

# ---------------- mutaciones: cada una DEBE hacer fallar la prueba
if [ -z "${NO_MUT:-}" ]; then
  echo "== mutaciones (cada una debe terminar con exit 1)"
  mut() { # id archivo-migracion descripcion sed-expr puerto
    local id=$1 file=$2 desc=$3 expr=$4 port=$5
    mkdir -p "$WORK/mig_$id"; cp "$REALMIGS"/*.sql "$WORK/mig_$id/"
    sed "$expr" "$REALMIGS/$file" > "$WORK/mig_$id/$file"
    if cmp -s "$WORK/mig_$id/$file" "$REALMIGS/$file"; then echo "FAIL  $id la mutacion no se aplico ($desc)" | tee -a "$LOG"; return; fi
    env NO_MUT=1 PGPORT_TEST=$port MIGDIR="$WORK/mig_$id" "$0" > "$WORK/mut_$id.out" 2>&1; local rc=$?
    echo "   $id $desc -> exit $rc: $(grep RESUMEN "$WORK/mut_$id.out" | head -1) | primeros FAIL: $(grep -E '^FAIL' "$WORK/mut_$id.out" | head -2 | cut -c1-90 | tr '\n' ';')"
    [ $rc -eq 1 ] && echo "PASS  $id la prueba detecta la mutacion ($desc)" | tee -a "$LOG" || echo "FAIL  $id la prueba NO detecto la mutacion ($desc)" | tee -a "$LOG"
    rm -rf "$WORK/mig_$id"
  }
  mut M1 20261112122000_order_fulfillment_billing_columns.sql "sin FK de perfil en pedidos" "s/^create index sales_orders_billing_profile_idx.*/alter table public.sales_orders drop constraint sales_orders_billing_profile_fkey;/" 54432
  mut M2 20261112123000_order_fulfillment_functions.sql "el guard exige direccion en todo fulfillment" "s/if new.fulfillment_method = 'delivery' then/if true then/" 54433
  mut M3 20261112125000_sales_order_billing_shipping_lock.sql "el candado ignora shipping_snapshot" "s/    or old.shipping_snapshot is distinct from new.shipping_snapshot/    or false/" 54434
  mut M4 20261112120000_client_billing_profiles.sql "sin indice de un solo predeterminado" "s/where is_default and deleted_at is null;/where false;/" 54435
  mut M5 20261112123000_order_fulfillment_functions.sql "el guard no congela shipping_snapshot" "s/new.shipping_snapshot := jsonb_build_object(/perform jsonb_build_object(/" 54436
  mut M6 20261112130500_billing_email_optional_named_buyers.sql "los efectos ignoran el perfil de facturacion" "s/v_use_bp := found;/v_use_bp := false;/g" 54437
  mut M7 20261112122000_order_fulfillment_billing_columns.sql "POS no se fuerza a on_site" "s/if new.sales_channel = 'pos' then new.fulfillment_method := 'on_site'; end if;/null;/" 54438
  mut M8 20261112129000_cart_one_off_shipping_destination.sql "save_cart_lines ignora billing_profile_id" "/billing_profile_id = case when v_patch/d" 54439
  mut M9 20261112121000_client_billing_profiles_backfill.sql "el backfill incluye a los walk-in" "s/  and not c.is_walk_in/  and true/" 54440
  mut M10 20261112122000_order_fulfillment_billing_columns.sql "la policy de correcciones no exige corrected_by = auth.uid()" "s/    and corrected_by = auth.uid());/    );/" 54441
  mut M11 20261112122000_order_fulfillment_billing_columns.sql "el trigger no valida la direccion de envio" "s/  if new.shipping_address_id is not null and new.contact_id is not null/  if false and new.shipping_address_id is not null and new.contact_id is not null/" 54442
  mut M12 20261112122000_order_fulfillment_billing_columns.sql "no se limpia la direccion al cambiar de cliente" "s/      new.shipping_address_id := null;/      null;/" 54443
  mut M13 20261112122000_order_fulfillment_billing_columns.sql "no se limpia el perfil al cambiar de cliente" "s/      new.billing_profile_id := null;/      null;/" 54444
  mut M14 20261112132000_contact_addresses_dedupe.sql "la clave se recalcula siempre en UPDATE" "s/  if tg_op = 'UPDATE'\$/  if false/" 54445
  mut M15 20261112132000_contact_addresses_dedupe.sql "constraint de unicidad con otro nombre" "s/contact_addresses_unique_address_per_client/contact_addresses_dedupe_x/g" 54446
  mut M16 20261112120000_client_billing_profiles.sql "el trigger que prohibe perfiles bajo el walk-in no actua" "s/  for each row execute function public.client_billing_profiles_no_walk_in();/  for each row when (false) execute function public.client_billing_profiles_no_walk_in();/" 54447
  mut M17 20261112130500_billing_email_optional_named_buyers.sql "los efectos toman el perfil predeterminado tambien para el walk-in" "s/if not v_use_bp and not coalesce(v_client.is_walk_in, false) then/if not v_use_bp then/" 54448
  mut M18 20261112130500_billing_email_optional_named_buyers.sql "el snapshot SQL copia el correo de la ficha del cliente" "s/'email', null,/'email', (select c.email from public.clients c where c.id = new.contact_id),/g" 54449
  mut M19 20261112128000_correct_order_shipping.sql "la auditoria de la correccion de destino no es atomica (error tragado)" "s/^  insert into public.sales_order_shipping_corrections (/  begin insert into public.sales_order_shipping_corrections (/;s/^  );\$/  ); exception when others then null; end;/" 54450
  mut M20 20261112123000_order_fulfillment_functions.sql "el guard reemplaza el destino puntual por la direccion predeterminada" "s/    if new.shipping_address_id is null and coalesce(btrim(new.shipping_snapshot ->> 'line1'), '') = '' then/    if new.shipping_address_id is null then/" 54451
  mut M21 20261112129000_cart_one_off_shipping_destination.sql "save_cart_lines ignora la clave shipping_snapshot" "/shipping_snapshot = case when v_patch/d" 54452
  mut M22 20261112128000_correct_order_shipping.sql "correct_order_shipping ignora el destino puntual" "s/  elsif p_new_destination is not null then/  elsif false then/" 54453
  mut M23 20261112130500_billing_email_optional_named_buyers.sql "un perfil con nombre sin correo vuelve a bloquear la factura" "s/^        if nullif(btrim(v_bp.email), '') is not null\$/        if nullif(btrim(v_bp.email), '') is null then v_missing := array_append(v_missing, 'correo de facturación'); end if; if nullif(btrim(v_bp.email), '') is not null/" 54454
fi
summary
