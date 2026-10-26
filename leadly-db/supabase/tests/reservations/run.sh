#!/usr/bin/env bash
# Prueba la migracion 20261026120000_stock_reservations.sql en un Postgres 15 DESCARTABLE
# (NO toca ninguna base real). Aplica las migraciones REALES de carts / save_cart_lines /
# triggers de stock / cancelacion y luego la migracion nueva.
# Uso: tests/reservations/run.sh -> "RESUMEN N PASS, M FAIL"; exit != 0 ante cualquier fallo.
# Variables: MIG (migracion a probar), NO_MUT=1 (omite mutaciones; evita recursion).
set -uo pipefail
PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@15/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
MIGS="$HERE/../../migrations"
MIG=${MIG:-$MIGS/20261026120000_stock_reservations.sql}
R2MIG=${R2MIG:-$MIGS/20261026130000_stock_availability_api.sql}
WORK=$(mktemp -d); PORT=${PGPORT_TEST:-54411}
export PGHOST=127.0.0.1 PGPORT=$PORT PGUSER=postgres PGDATABASE=postgres
"$PGBIN/initdb" -D "$WORK/data" -U postgres --auth=trust >/dev/null || exit 2
"$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$WORK" -l "$WORK/pg.log" -w start >/dev/null || exit 2
cleanup() { "$PGBIN/pg_ctl" -D "$WORK/data" -m fast stop >/dev/null 2>&1; rm -rf "$WORK"; }
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
sqlf() { local db=$1; shift; PGDATABASE=$db PGOPTIONS='-c client_min_messages=warning' $PSQL -v ON_ERROR_STOP=1 -f "$1" > "$WORK/out.txt" 2>&1; local rc=$?; [ $rc -ne 0 ] && { tail -5 "$WORK/out.txt"; return $rc; }; return 0; }
mkdb() { $PSQL -d postgres -c "drop database if exists $1" -c "create database $1 template $2" >/dev/null || die "createdb $1"; }
report() { echo "== $2"; PGDATABASE=$1 $PSQL -c "select case when ok then 'PASS  ' else 'FAIL  ' end || name || case when ok then '' else '  -- ' || coalesce(detail, '') end from t.results order by n" | tee -a "$LOG"; }
runtests() { # db archivo etiqueta
  PGDATABASE=$1 PGOPTIONS='-c client_min_messages=warning' $PSQL -v ON_ERROR_STOP=1 -f "$2" > "$WORK/out_t.txt" 2>&1; local rc=$?
  report "$1" "$3"
  [ $rc -ne 0 ] && echo "FAIL  ($3: psql aborto rc=$rc) $(grep -E 'ERROR|FATAL' "$WORK/out_t.txt" | head -2 | tr '\n' ' ')" | tee -a "$LOG"
}

# ------------------------------------------------ base con el esquema REAL previo a la migracion
$PSQL -d postgres -c "create database b0" >/dev/null || die "createdb b0"
sqlf b0 "$HERE/00_stubs.sql" || die "stubs"
sqlf b0 "$HERE/01_helpers.sql" || die "helpers"
sqlf b0 "$MIGS/20260904145708_carts_and_cart_items.sql" || die "carts"
sqlf b0 "$MIGS/20260904145722_sales_orders_cart_columns.sql" || die "sales_orders cart cols"
sed -n '/^alter table public.carts drop constraint carts_origin_check;/,/^alter table public.carts add column session_token text unique;/p' "$MIGS/20260904210000_storefront_uses_shared_carts.sql" > "$WORK/sf.sql"
[ -s "$WORK/sf.sql" ] || die "extraer origin storefront"
sqlf b0 "$WORK/sf.sql" || die "origin storefront"
sqlf b0 "$MIGS/20260921130000_save_cart_lines_atomic.sql" || die "save_cart_lines previa"
# funciones reales de stock: apply_stock_movement, salida al confirmar, reversion al cancelar
sed -n '/^create or replace function public.apply_stock_movement()/,/^\$function\$;/p' "$MIGS/20260825143849_remove_reserve_departure_and_dispatch_stock_effect.sql" > "$WORK/asm.sql"
sed -n '/^create or replace function public.apply_sales_order_confirmed_stock_effect/,/^  execute function public.apply_sales_order_confirmed_stock_effect();/p' "$MIGS/20260825134917_simplify_stock_effects_venta_only.sql" > "$WORK/conf.sql"
sed -n '/^create or replace function public.apply_sales_order_cancelled_stock_effect/,/^  execute function public.apply_sales_order_cancelled_stock_effect();/p' "$MIGS/20260905190000_sales_order_cancel_stock_reversal.sql" > "$WORK/canc.sql"
for f in asm conf canc; do [ -s "$WORK/$f.sql" ] || die "extraer $f"; sqlf b0 "$WORK/$f.sql" || die "aplicar $f"; done
$PSQL -d b0 -c "create trigger trg_stock_movements_apply after insert on public.stock_movements for each row execute function public.apply_stock_movement();" >/dev/null || die "trigger stock"

# ------------------------------------------------ 1. backfill sobre cuentas POS abiertas preexistentes
mkdb bbf b0
cat > "$WORK/prefix.sql" <<'SQL'
set client_min_messages = warning;
select t.tenant('tkb'); select t.product('pkb', 'tkb', 5);
select t.cart('kb_old', 'tkb'); select t.cart('kb_new', 'tkb'); select t.cart('kb_sf', 'tkb', 'storefront'); select t.cart('kb_portal', 'tkb', 'portal'); select t.cart('kb_closed', 'tkb');
-- la cuenta vieja primero (created_at distinto para fijar el orden del backfill)
update public.carts set created_at = now() - interval '2 hours' where id = t.id('kb_old');
select t.save('kb_old', 'tkb', jsonb_build_array(t.line('pkb', 3)));
select t.save('kb_new', 'tkb', jsonb_build_array(t.line('pkb', 4)));
select t.save('kb_sf', 'tkb', jsonb_build_array(t.line('pkb', 1)));
select t.save('kb_portal', 'tkb', jsonb_build_array(t.line('pkb', 1)));
select t.save('kb_closed', 'tkb', jsonb_build_array(t.line('pkb', 1)));
update public.carts set status = 'converted' where id = t.id('kb_closed');
SQL
sqlf bbf "$WORK/prefix.sql" || die "preparar cuentas abiertas previas"
PGDATABASE=bbf PGOPTIONS='-c client_min_messages=notice' $PSQL -v ON_ERROR_STOP=1 -f "$MIG" > "$WORK/mig_bf.txt" 2>&1 || { tail -5 "$WORK/mig_bf.txt"; die "aplicar migracion sobre datos previos"; }
grep -q "backfill: 2 cuentas POS" "$WORK/mig_bf.txt" && echo "PASS  K0 el backfill proceso exactamente las 2 cuentas POS abiertas" | tee -a "$LOG" || echo "FAIL  K0 aviso del backfill: $(grep backfill "$WORK/mig_bf.txt")" | tee -a "$LOG"
runtests bbf "$HERE/20_backfill.sql" "1. Backfill de cuentas POS abiertas"

# ------------------------------------------------ 2. funcionales
mkdb bnew b0
sqlf bnew "$MIG" || die "aplicar migracion (base vacia)"
runtests bnew "$HERE/10_reservations.sql" "2. Reservas: escenarios funcionales"

# ------------------------------------------------ 2b. R2: DTO de disponibilidad + guard + settle
mkdb br2 b0
sqlf br2 "$MIG" || die "aplicar R1 (R2)"
sqlf br2 "$R2MIG" || die "aplicar migracion R2"
runtests br2 "$HERE/40_r2_api.sql" "2b. R2: DTO available, guard de confirmacion, cobro de cuenta"

# ------------------------------------------------ 3. concurrencia real (dos sesiones)
mkdb bconc b0
sqlf bconc "$MIG" || die "migracion (concurrencia)"
PGDATABASE=bconc $PSQL -c "select t.tenant('tk'); select t.product('pk', 'tk', 1); select t.cart('ck1', 'tk'); select t.cart('ck2', 'tk');" >/dev/null || die "datos de concurrencia"
( PGDATABASE=bconc $PSQL -v ON_ERROR_STOP=1 -f "$HERE/30_concurrency_a.sql" > "$WORK/conc_a.txt" 2>&1 ) &
PA=$!
sleep 1
PGDATABASE=bconc PGOPTIONS='-c client_min_messages=warning' $PSQL -v ON_ERROR_STOP=1 -f "$HERE/31_concurrency_b.sql" > "$WORK/conc_b.txt" 2>&1
wait $PA
report bconc "3. Concurrencia real: dos cajas, ultima unidad"

# ------------------------------------------------ 3b. H2: deadlock entre save_cart_lines y el cobro
h2() { # etiqueta archivoB
  mkdb bdl$1 b0; sqlf bdl$1 "$MIG" || die "migracion (h2)"; sqlf bdl$1 "$R2MIG" || die "migracion R2 (h2)"
  PGDATABASE=bdl$1 $PSQL -c "select t.tenant('td'); select t.product('pd1', 'td', 20); select t.product('pd2', 'td', 20); select t.cart('cd', 'td'); select t.save('cd', 'td', jsonb_build_array(t.line('pd1', 1), t.line('pd2', 1)));" >/dev/null || die "datos h2"
  ( PGDATABASE=bdl$1 $PSQL -f "$HERE/50_h2_session_a.sql" > "$WORK/h2a_$1.txt" 2>&1 ) &
  local PA=$!
  PGDATABASE=bdl$1 $PSQL -f "$HERE/$2" > "$WORK/h2b_$1.txt" 2>&1
  wait $PA
}
h2 old 51_h2_session_b_old.sql
if grep -qi "deadlock detected" "$WORK/h2a_old.txt" "$WORK/h2b_old.txt"; then echo "PASS  H2a el patron viejo (DELETE y luego lock del carrito) SI produce deadlock con save_cart_lines (H2 confirmado)" | tee -a "$LOG"; else echo "FAIL  H2a no se reprodujo el deadlock del patron viejo: $(cat "$WORK/h2a_old.txt" "$WORK/h2b_old.txt" | tr '\n' ' ' | cut -c1-300)" | tee -a "$LOG"; fi
h2 new 52_h2_session_b_new.sql
if grep -q "B_RESULT ok" "$WORK/h2b_new.txt" && grep -q "A_RESULT ok" "$WORK/h2a_new.txt" && ! grep -qi "deadlock" "$WORK/h2a_new.txt" "$WORK/h2b_new.txt"; then echo "PASS  H2b con cart_settle_billed_items ambas sesiones terminan sin deadlock" | tee -a "$LOG"; else echo "FAIL  H2b con el patron nuevo: $(cat "$WORK/h2a_new.txt" "$WORK/h2b_new.txt" | tr '\n' ' ' | cut -c1-300)" | tee -a "$LOG"; fi

# ------------------------------------------------ mutaciones: cada una DEBE hacer fallar la prueba
if [ -z "${NO_MUT:-}" ]; then
  echo "== mutaciones (cada una debe terminar con exit 1)"
  mut() { # id descripcion sed-expr puerto
    local id=$1 desc=$2 expr=$3 port=$4
    sed "$expr" "$MIG" > "$WORK/mut_$id.sql"
    if cmp -s "$WORK/mut_$id.sql" "$MIG"; then echo "FAIL  $id la mutacion no se aplico ($desc)" | tee -a "$LOG"; return; fi
    env NO_MUT=1 PGPORT_TEST=$port MIG="$WORK/mut_$id.sql" "$0" > "$WORK/mut_$id.out" 2>&1; local rc=$?
    echo "   $id $desc -> exit $rc: $(grep RESUMEN "$WORK/mut_$id.out") | primeros FAIL: $(grep -E '^FAIL' "$WORK/mut_$id.out" | head -2 | cut -c1-100 | tr '\n' ';')"
    [ $rc -eq 1 ] && echo "PASS  $id la prueba detecta la mutacion ($desc)" | tee -a "$LOG" || echo "FAIL  $id la prueba NO detecto la mutacion ($desc)" | tee -a "$LOG"
  }
  mut M1 "sin lock por producto (permite sobreventa concurrente)" "/perform pg_advisory_xact_lock(/,/^    );/d" 54412
  mut M2 "no se consume la reserva al confirmar" "s/create trigger sales_orders_consume_cart_reservation after update of status on public.sales_orders/create trigger sales_orders_consume_cart_reservation after update of tenant_id on public.sales_orders/" 54413
  mut M3 "disponible cuenta reservas vencidas" "s/and (r.expires_at is null or r.expires_at > now())/and true/" 54414
  mut M4 "cerrar el carrito no libera" "s/after update of status on public.carts/after update of tenant_id on public.carts/" 54415
  mut M5 "sin renovacion deslizante" "s/do update set quantity = excluded.quantity, expires_at = excluded.expires_at;/do update set quantity = excluded.quantity;/" 54416
  mut M6 "variante ignorada en el disponible (compara igualdad estricta)" "$(grep -n 'ps.variant_id is not distinct from p_variant_id' "$MIG" | head -1 | cut -d: -f1)s/is not distinct from p_variant_id/= p_variant_id/" 54417
  mut M7 "el aislamiento de tenant en productos del carrito se omite" "s/and p.tenant_id = p_tenant_id\$/and true/" 54418
  mut2() { # id descripcion sed-expr puerto  (muta la migracion R2)
    local id=$1 desc=$2 expr=$3 port=$4
    sed "$expr" "$R2MIG" > "$WORK/mut_$id.sql"
    if cmp -s "$WORK/mut_$id.sql" "$R2MIG"; then echo "FAIL  $id la mutacion no se aplico ($desc)" | tee -a "$LOG"; return; fi
    env NO_MUT=1 PGPORT_TEST=$port R2MIG="$WORK/mut_$id.sql" "$0" > "$WORK/mut_$id.out" 2>&1; local rc=$?
    echo "   $id $desc -> exit $rc: $(grep RESUMEN "$WORK/mut_$id.out") | primeros FAIL: $(grep -E '^FAIL' "$WORK/mut_$id.out" | head -2 | cut -c1-100 | tr '\n' ';')"
    [ $rc -eq 1 ] && echo "PASS  $id la prueba detecta la mutacion ($desc)" | tee -a "$LOG" || echo "FAIL  $id la prueba NO detecto la mutacion ($desc)" | tee -a "$LOG"
  }
  mut2 R2M1 "el guard ignora las reservas (solo fisico)" "s/v_available := v_physical - v_reserved;/v_available := v_physical;/" 54420
  mut2 R2M2 "el guard no excluye el carrito del propio pedido" "s/and (new.cart_id is null or r.cart_id <> new.cart_id);/and true;/" 54421
  mut2 R2M3 "el DTO por bodega consulta con tenant nulo (no resuelve el tenant de la sesion)" "s/from public.stock_availability_rows(public.auth_active_tenant_id(), p_product_ids, p_exclude_cart_id) r/from public.stock_availability_rows(null, p_product_ids, p_exclude_cart_id) r/" 54422
  mut2 R2M4 "el DTO no filtra productos sin track_inventory" "s/and p.track_inventory = true\$/and true/" 54423
  mut M8 "la reserva no excluye al propio carrito" "s/and (p_exclude_cart_id is null or r.cart_id <> p_exclude_cart_id)\$/and true/" 54419
fi
summary
