#!/usr/bin/env bash
# Prueba las migraciones de insumos/ficha tecnica (20261027120000 + 20261027130000) en un
# Postgres 15 DESCARTABLE sobre el esquema REAL previo (stubs + migraciones reales de carts,
# save_cart_lines, triggers de stock, reservas R1/R2). NO toca ninguna base real.
# Uso: tests/materials/run.sh -> "RESUMEN N PASS, M FAIL"; exit != 0 ante fallo. NO_MUT=1 omite mutaciones.
set -uo pipefail
PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@15/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
RES="$HERE/../reservations"
MIGS="$HERE/../../migrations"
M1=${M1:-$MIGS/20261027120000_materials_bom_schema.sql}
M2=${M2:-$MIGS/20261027130000_materials_bom_stock_effects.sql}
WORK=$(mktemp -d); PORT=${PGPORT_TEST:-54431}
export PGHOST=127.0.0.1 PGPORT=$PORT PGUSER=postgres PGDATABASE=postgres
"$PGBIN/initdb" -D "$WORK/data" -U postgres --auth=trust >/dev/null || exit 2
"$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$WORK" -l "$WORK/pg.log" -w start >/dev/null || exit 2
cleanup() { "$PGBIN/pg_ctl" -D "$WORK/data" -m fast stop >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
PSQL="$PGBIN/psql -X -q -t -A"
LOG="$WORK/assertions.log"; : > "$LOG"
summary() { local np nf; np=$(grep -c '^PASS' "$LOG" || true); nf=$(grep -c '^FAIL' "$LOG" || true); echo "RESUMEN $np PASS, $nf FAIL"; if [ "$nf" -ne 0 ] || [ "$np" -eq 0 ]; then exit 1; fi; exit 0; }
die() { echo "FAIL  (preparacion: $1)" | tee -a "$LOG"; summary; }
sqlf() { local db=$1; shift; PGDATABASE=$db PGOPTIONS='-c client_min_messages=warning' $PSQL -v ON_ERROR_STOP=1 -f "$1" > "$WORK/out.txt" 2>&1; local rc=$?; [ $rc -ne 0 ] && { tail -5 "$WORK/out.txt"; return $rc; }; return 0; }
report() { echo "== $2"; PGDATABASE=$1 $PSQL -c "select case when ok then 'PASS  ' else 'FAIL  ' end || name || case when ok then '' else '  -- ' || coalesce(detail, '') end from t.results order by n" | tee -a "$LOG"; }

$PSQL -d postgres -c "create database b0" >/dev/null || die "createdb"
sqlf b0 "$RES/00_stubs.sql" || die "stubs"
sqlf b0 "$RES/01_helpers.sql" || die "helpers"
sqlf b0 "$HERE/00_stubs_materials.sql" || die "stubs materials"
sqlf b0 "$MIGS/20260904145708_carts_and_cart_items.sql" || die "carts"
sqlf b0 "$MIGS/20260904145722_sales_orders_cart_columns.sql" || die "sales_orders cart cols"
sed -n '/^alter table public.carts drop constraint carts_origin_check;/,/^alter table public.carts add column session_token text unique;/p' "$MIGS/20260904210000_storefront_uses_shared_carts.sql" > "$WORK/sf.sql"
[ -s "$WORK/sf.sql" ] || die "extraer origin storefront"; sqlf b0 "$WORK/sf.sql" || die "origin storefront"
sqlf b0 "$MIGS/20260921130000_save_cart_lines_atomic.sql" || die "save_cart_lines previa"
sed -n '/^create or replace function public.apply_stock_movement()/,/^\$function\$;/p' "$MIGS/20260825143849_remove_reserve_departure_and_dispatch_stock_effect.sql" > "$WORK/asm.sql"
sed -n '/^create or replace function public.apply_sales_order_confirmed_stock_effect/,/^  execute function public.apply_sales_order_confirmed_stock_effect();/p' "$MIGS/20260825134917_simplify_stock_effects_venta_only.sql" > "$WORK/conf.sql"
sed -n '/^create or replace function public.apply_sales_order_cancelled_stock_effect/,/^  execute function public.apply_sales_order_cancelled_stock_effect();/p' "$MIGS/20260905190000_sales_order_cancel_stock_reversal.sql" > "$WORK/canc.sql"
for f in asm conf canc; do [ -s "$WORK/$f.sql" ] || die "extraer $f"; sqlf b0 "$WORK/$f.sql" || die "aplicar $f"; done
$PSQL -d b0 -c "create trigger trg_stock_movements_apply after insert on public.stock_movements for each row execute function public.apply_stock_movement();" >/dev/null || die "trigger stock"
sqlf b0 "$MIGS/20261026120000_stock_reservations.sql" || die "R1"
sqlf b0 "$MIGS/20261026130000_stock_availability_api.sql" || die "R2"
# el catalogo de modulos REAL previo (la migracion nueva lo redefine)
sqlf b0 "$M1" || die "migracion insumos (esquema)"
sqlf b0 "$M2" || die "migracion insumos (efectos)"
$PSQL -d postgres -c "create database bt template b0" >/dev/null || die "createdb bt"
PGDATABASE=bt PGOPTIONS='-c client_min_messages=warning' $PSQL -v ON_ERROR_STOP=0 -f "$HERE/10_materials.sql" > "$WORK/out_t.txt" 2>&1
report bt "Insumos / ficha tecnica"
grep -E 'ERROR|FATAL' "$WORK/out_t.txt" | head -3 | sed 's/^/FAIL  (psql) /' | tee -a "$LOG"

# Regresion: las pruebas de reservas (R1/R2, productos 'stock') corren IGUAL con las migraciones de insumos aplicadas.
for f in 10_reservations 40_r2_api; do
  $PSQL -d postgres -c "create database br_$f template b0" >/dev/null || die "createdb br_$f"
  PGDATABASE=br_$f PGOPTIONS='-c client_min_messages=warning' $PSQL -v ON_ERROR_STOP=0 -f "$RES/$f.sql" > "$WORK/out_$f.txt" 2>&1
  report br_$f "Regresion reservas: $f (con insumos aplicado)"
done

if [ -z "${NO_MUT:-}" ]; then
  echo "== mutaciones (cada una debe terminar con exit 1)"
  mut() { # id desc archivo(M2|M1) sed port
    local id=$1 desc=$2 which=$3 expr=$4 port=$5 src; src=$([ "$which" = M1 ] && echo "$M1" || echo "$M2")
    sed "$expr" "$src" > "$WORK/mut_$id.sql"
    if cmp -s "$WORK/mut_$id.sql" "$src"; then echo "FAIL  $id la mutacion no se aplico ($desc)" | tee -a "$LOG"; return; fi
    if [ "$which" = M1 ]; then env NO_MUT=1 PGPORT_TEST=$port M1="$WORK/mut_$id.sql" "$0" > "$WORK/mut_$id.out" 2>&1; else env NO_MUT=1 PGPORT_TEST=$port M2="$WORK/mut_$id.sql" "$0" > "$WORK/mut_$id.out" 2>&1; fi
    local rc=$?
    echo "   $id $desc -> exit $rc: $(grep RESUMEN "$WORK/mut_$id.out") | $(grep -E '^FAIL' "$WORK/mut_$id.out" | head -2 | cut -c1-90 | tr '\n' ';')"
    [ $rc -eq 1 ] && echo "PASS  $id la prueba detecta la mutacion ($desc)" | tee -a "$LOG" || echo "FAIL  $id la prueba NO detecto la mutacion ($desc)" | tee -a "$LOG"
  }
  mut X1 "no se suma el consumo de un insumo compartido al comparar (max en vez de sum)" M2 "s/sum(d.need) as required/max(d.need) as required/" 54432
  mut X1b "no se suma el consumo de un insumo compartido al descontar (max en vez de sum)" M2 "s/sum(soi.quantity \\* b.quantity) as quantity/max(soi.quantity * b.quantity) as quantity/" 54441
  mut X2 "sin reversion al anular (trigger eliminado)" M2 "/create trigger trg_sales_orders_cancelled_materials_effect/,/execute function public.apply_sales_order_cancelled_materials_effect();/d" 54433
  mut X3 "reversion bruta (ignora entradas ya devueltas)" M2 "s/case mm.movement_type when 'salida' then mm.quantity else -mm.quantity end/case mm.movement_type when 'salida' then mm.quantity else 0 end/g" 54434
  mut X4 "el producto recipe tambien descuenta stock propio (doble descuento)" M2 "s/^      and p.inventory_mode = 'stock'\$/      and true/" 54435
  mut X5 "el guard ignora los insumos" M2 "s/from public.recipe_shortfalls(new.tenant_id, v_items, new.cart_id)/from public.recipe_shortfalls(new.tenant_id, '[]'::jsonb, new.cart_id)/" 54436
  mut X6 "disponible de insumo ignora reservas ajenas" M2 "s/r.tenant_id = p_tenant_id and r.material_id = p_material_id/r.tenant_id = p_tenant_id and false/" 54437
  mut X7 "sin aislamiento de tenant en insumos de BOM/movimientos" M1 "s/m.id = new.material_id and m.tenant_id = new.tenant_id/m.id = new.material_id/" 54438
  mut X8 "cerrar el carrito no libera insumos" M2 "s/  delete from public.material_reservations where cart_id = new.id;//" 54439
  mut X9 "recipe sin ficha se considera disponible (no bloquea)" M2 "s/where not exists (select 1 from public.product_bom b where b.product_id = p.id and b.tenant_id = p_tenant_id)\$/where false/" 54440
fi
summary
