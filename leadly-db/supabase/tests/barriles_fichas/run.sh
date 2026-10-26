#!/usr/bin/env bash
# Prueba la migracion 20261027160000 (insumos por porcion, parte del estado que dejo la 150000). Base: 20261027150000 (insumos + fichas de Barriles) en un Postgres 15 DESCARTABLE, sobre el
# esquema real previo (mismo montaje que tests/materials/run.sh) con un tenant de forma real (id y nombre fijos,
# 35 productos con nombres exactos + senuelos). NO toca ninguna base real.
set -uo pipefail
PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@15/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
RES="$HERE/../reservations"; MAT="$HERE/../materials"; MIGS="$HERE/../../migrations"
MIG150=$MIGS/20261027150000_barriles_materials_and_recipes.sql
MIG=${MIG:-$MIGS/20261027160000_barriles_materials_by_portion.sql}
WORK=$(mktemp -d); PORT=${PGPORT_TEST:-54451}
export PGHOST=127.0.0.1 PGPORT=$PORT PGUSER=postgres PGDATABASE=postgres
"$PGBIN/initdb" -D "$WORK/data" -U postgres --auth=trust >/dev/null || exit 2
"$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$WORK" -l "$WORK/pg.log" -w start >/dev/null || exit 2
trap '"$PGBIN/pg_ctl" -D "$WORK/data" -m fast stop >/dev/null 2>&1; rm -rf "$WORK"' EXIT
PSQL="$PGBIN/psql -X -q -t -A"
LOG="$WORK/log"; : > "$LOG"
summary() { local np nf; np=$(grep -c '^PASS' "$LOG" || true); nf=$(grep -c '^FAIL' "$LOG" || true); echo "RESUMEN $np PASS, $nf FAIL"; [ "$nf" -eq 0 ] && [ "$np" -gt 0 ]; exit $?; }
die() { echo "FAIL  (preparacion: $1)" | tee -a "$LOG"; summary; }
sqlf() { local db=$1; shift; PGDATABASE=$db PGOPTIONS='-c client_min_messages=warning' $PSQL -v ON_ERROR_STOP=1 -f "$1" > "$WORK/out.txt" 2>&1 || { tail -5 "$WORK/out.txt"; return 1; }; }
q() { PGDATABASE=$1 $PSQL -c "$2"; }
ck() { if [ "$2" = "$3" ]; then echo "PASS  $1" | tee -a "$LOG"; else echo "FAIL  $1 (obtenido '$2', esperado '$3')" | tee -a "$LOG"; fi; }

# --- esquema previo real (copiado de tests/materials/run.sh) ---
$PSQL -d postgres -c "create database b0" >/dev/null || die createdb
sqlf b0 "$RES/00_stubs.sql" || die stubs; sqlf b0 "$RES/01_helpers.sql" || die helpers; sqlf b0 "$MAT/00_stubs_materials.sql" || die stubs2
sqlf b0 "$MIGS/20260904145708_carts_and_cart_items.sql" || die carts
sqlf b0 "$MIGS/20260904145722_sales_orders_cart_columns.sql" || die soc
sed -n '/^alter table public.carts drop constraint carts_origin_check;/,/^alter table public.carts add column session_token text unique;/p' "$MIGS/20260904210000_storefront_uses_shared_carts.sql" > "$WORK/sf.sql"; sqlf b0 "$WORK/sf.sql" || die sf
sqlf b0 "$MIGS/20260921130000_save_cart_lines_atomic.sql" || die scl
sed -n '/^create or replace function public.apply_stock_movement()/,/^\$function\$;/p' "$MIGS/20260825143849_remove_reserve_departure_and_dispatch_stock_effect.sql" > "$WORK/asm.sql"
sed -n '/^create or replace function public.apply_sales_order_confirmed_stock_effect/,/^  execute function public.apply_sales_order_confirmed_stock_effect();/p' "$MIGS/20260825134917_simplify_stock_effects_venta_only.sql" > "$WORK/conf.sql"
sed -n '/^create or replace function public.apply_sales_order_cancelled_stock_effect/,/^  execute function public.apply_sales_order_cancelled_stock_effect();/p' "$MIGS/20260905190000_sales_order_cancel_stock_reversal.sql" > "$WORK/canc.sql"
for f in asm conf canc; do sqlf b0 "$WORK/$f.sql" || die "$f"; done
$PSQL -d b0 -c "create trigger trg_stock_movements_apply after insert on public.stock_movements for each row execute function public.apply_stock_movement();" >/dev/null || die trg
sqlf b0 "$MIGS/20261026120000_stock_reservations.sql" || die R1
sqlf b0 "$MIGS/20261026130000_stock_availability_api.sql" || die R2
sqlf b0 "$MIGS/20261027120000_materials_bom_schema.sql" || die m1
sqlf b0 "$MIGS/20261027130000_materials_bom_stock_effects.sql" || die m2

# --- forma real del tenant: columnas que el stub no trae + tenant de produccion ---
cat > "$WORK/fx.sql" <<'SQL'
alter table public.products add column is_active boolean not null default true;
alter table public.products add column deleted_at timestamptz;
alter table public.tenant_enabled_modules add column source text not null default 'manual';
alter table public.tenant_enabled_modules add constraint tem_uq unique (tenant_id, module_key);
insert into public.tenants(id, name) values ('9c79437d-1c19-4edc-bc1f-0dc06094823a', 'Barriles de la sexta');
insert into public.warehouses(tenant_id, name, is_default) select id, 'Principal', true from public.tenants;
-- otro tenant con productos del mismo nombre (no debe tocarse)
insert into public.tenants(id, name) values ('00000000-0000-0000-0000-0000000000aa', 'Otro');
insert into public.products(tenant_id, name) values ('00000000-0000-0000-0000-0000000000aa', 'Churrasco');
SQL
sed -nE "s/^    \('([^']*)', '([^']*)', .*/\1|\2/p" "$MIG150" | grep -v '|kg$\|.|un$' > /dev/null 2>&1
# nombres de producto = primera columna de _fm_bom (filas con 3 campos)
grep -E "^    \('[^']*', '[^']*', [0-9.]+\)[,;]" "$MIG150" | sed -E "s/^    \('([^']*)'.*/\1/" | sort -u > "$WORK/names.txt"
N=$(wc -l < "$WORK/names.txt" | tr -d " "); ck "P0 la prueba lee 35 nombres de producto de la migracion" "$N" 35
while IFS= read -r n; do
  esc=${n//\'/\'\'}
  echo "insert into public.products(tenant_id, name) values ('9c79437d-1c19-4edc-bc1f-0dc06094823a', '$esc');" >> "$WORK/fx.sql"
done < "$WORK/names.txt"
cat >> "$WORK/fx.sql" <<'SQL'
-- senuelos: quedan en 'stock'
insert into public.products(tenant_id, name) values
  ('9c79437d-1c19-4edc-bc1f-0dc06094823a', 'Costilla de cerdo ahumada al barril'),
  ('9c79437d-1c19-4edc-bc1f-0dc06094823a', 'Parrillada / campestre'),
  ('9c79437d-1c19-4edc-bc1f-0dc06094823a', 'Churrasco '),          -- con espacio final: NO es el nombre exacto
  ('9c79437d-1c19-4edc-bc1f-0dc06094823a', 'churrasco');           -- otra capitalizacion
-- stock propio y reserva de una cuenta POS abierta con un producto que pasa a recipe
insert into public.product_stock(tenant_id, product_id, warehouse_id, quantity)
  select tenant_id, id, (select id from public.warehouses where tenant_id = p.tenant_id limit 1), 7 from public.products p where name = 'Churrasco' and tenant_id = '9c79437d-1c19-4edc-bc1f-0dc06094823a';
insert into public.carts(id, tenant_id, origin) values ('c0000000-0000-0000-0000-000000000001', '9c79437d-1c19-4edc-bc1f-0dc06094823a', 'pos');
SQL
sqlf b0 "$WORK/fx.sql" || die fixture
# carrito abierto con 2 unidades de Churrasco, guardado por la ruta real del POS (crea reserva de stock propio)
cat > "$WORK/cart.sql" <<'SQL'
select public.save_cart_lines('c0000000-0000-0000-0000-000000000001', '9c79437d-1c19-4edc-bc1f-0dc06094823a', '{}'::jsonb,
  jsonb_build_array(jsonb_build_object('product_id', (select id from public.products where name = 'Churrasco' and tenant_id = '9c79437d-1c19-4edc-bc1f-0dc06094823a'),
   'variant_id', null, 'warehouse_id', null, 'product_name', 'Churrasco', 'sku', null, 'quantity', 2, 'unit_price', 30000)));
SQL
sqlf b0 "$WORK/cart.sql" || die cart
T=9c79437d-1c19-4edc-bc1f-0dc06094823a
ck "P1 reserva de stock propio previa (carrito abierto)" "$(q b0 "select sum(quantity) from public.stock_reservations")" 2
# --- estado previo real: aplica la migracion 150000 sobre b0 (12 insumos kg/un + 42 fichas + 35 recipe) ---
PGDATABASE=b0 PGOPTIONS='-c client_min_messages=warning' $PSQL -v ON_ERROR_STOP=1 -f "$MIG150" > "$WORK/m150.txt" 2>&1 || { tail -5 "$WORK/m150.txt"; die m150; }
ck "P2 estado previo: 12 insumos (10 kg), 42 fichas, 35 recipe" "$(q b0 "select (select count(*) from public.materials where tenant_id='$T') || '/' || (select count(*) from public.materials where unit='kg') || '/' || (select count(*) from public.product_bom) || '/' || (select count(*) from public.products where inventory_mode='recipe')")" "12/10/42/35"
# un insumo manual del cliente (otro nombre) que NO debe tocarse
q b0 "insert into public.materials(tenant_id,name,unit) values ('$T','Sal marina','kg')" >/dev/null
SNAP="select md5(coalesce(string_agg(id::text||name||unit||coalesce(deleted_at::text,'-'), ',' order by id),'')) from public.materials"
SNAPB="select md5(coalesce(string_agg(id::text||product_id::text||material_id::text||quantity::text, ',' order by id),'')) from public.product_bom"
mk() { $PSQL -d postgres -c "create database $1 template b0" >/dev/null || die "createdb $1"; }
run() { PGDATABASE=$1 PGOPTIONS='-c client_min_messages=notice' $PSQL -v ON_ERROR_STOP=1 -f "$MIG" > "$WORK/run_$1.txt" 2>&1; }
ml() { echo "select string_agg(p.name||':'||m.name||'='||pb.quantity::numeric(8,3), ',' order by p.name collate \"C\", m.name) from public.product_bom pb join public.materials m on m.id=pb.material_id join public.products p on p.id=pb.product_id where p.tenant_id='$T' and p.name $1"; }

# ===== S1: caso feliz =====
mk s1; OLDIDS=$(q s1 "select string_agg(id::text, ',' order by id) from public.materials where tenant_id='$T' and name in ('Chorizo','Huevo')")
run s1; ck "S1 migracion aplica sin error" "$?" 0
ck "S1 20 insumos nuevos vivos: un, costo 0, activos, min_stock null" "$(q s1 "select count(*) from public.materials where tenant_id='$T' and unit='un' and cost=0 and is_active and min_stock is null and deleted_at is null and name <> 'Sal marina'")" 20
ck "S1 ningun insumo kg vivo salvo el manual del cliente" "$(q s1 "select string_agg(name, ',') from public.materials where tenant_id='$T' and unit='kg' and deleted_at is null")" "Sal marina"
ck "S1 10 insumos viejos con soft-delete (no borrado real)" "$(q s1 "select count(*) from public.materials where tenant_id='$T' and deleted_at is not null")" 10
ck "S1 total de filas materials = 12 + 18 nuevos + 1 manual = 31" "$(q s1 "select count(*) from public.materials where tenant_id='$T'")" 31
ck "S1 insumo manual intacto" "$(q s1 "select unit||is_active::text||coalesce(deleted_at::text,'-') from public.materials where name='Sal marina'")" "kgtrue-"
ck "S1 Chorizo y Huevo conservan su id (reutilizados)" "$(q s1 "select string_agg(id::text, ',' order by id) from public.materials where tenant_id='$T' and name in ('Chorizo','Huevo') and deleted_at is null")" "$OLDIDS"
ck "S1 42 filas product_bom, todas con cantidad 1" "$(q s1 "select count(*) || '/' || count(*) filter (where quantity=1) from public.product_bom where tenant_id='$T'")" "42/42"
ck "S1 ninguna ficha apunta a insumo kg o borrado" "$(q s1 "select count(*) from public.product_bom pb join public.materials m on m.id=pb.material_id where m.unit<>'un' or m.deleted_at is not null")" 0
ck "S1 35 productos en recipe con track_inventory" "$(q s1 "select count(*) from public.products where tenant_id='$T' and inventory_mode='recipe' and track_inventory")" 35
ck "S1 senuelos siguen en stock (4)" "$(q s1 "select count(*) from public.products where tenant_id='$T' and inventory_mode='stock'")" 4
ck "S1 otro tenant intacto" "$(q s1 "select (select inventory_mode from public.products where tenant_id='00000000-0000-0000-0000-0000000000aa') || (select count(*) from public.materials where tenant_id <> '$T') || (select count(*) from public.product_bom where tenant_id <> '$T')")" "stock00"
ck "S1 Picada al barril" "$(q s1 "$(ml "= 'Picada al barril'")")" "Picada al barril:Chorizo=1.000,Picada al barril:Lomo de cerdo 130 g=1.000,Picada al barril:Lomo de res 130 g=1.000,Picada al barril:Pechuga de pollo 130 g=1.000"
ck "S1 Tabla mixta (3 porciones de 130 g)" "$(q s1 "$(ml "= 'Tabla mixta al barril'")")" "Tabla mixta al barril:Lomo de cerdo 130 g=1.000,Tabla mixta al barril:Lomo de res 130 g=1.000,Tabla mixta al barril:Pechuga de pollo 130 g=1.000"
ck "S1 Trucha marinera = trucha 500 + mixtura 150" "$(q s1 "$(ml "= 'Trucha a la marinera'")")" "Trucha a la marinera:Mixtura de mariscos 150 g=1.000,Trucha a la marinera:Trucha 500 g=1.000"
ck "S1 Mojarra marinera = mojarra 500 + mixtura 150" "$(q s1 "$(ml "= 'Filete de mojarra a la marinera'")")" "Filete de mojarra a la marinera:Mixtura de mariscos 150 g=1.000,Filete de mojarra a la marinera:Mojarra 500 g=1.000"
ck "S1 Churrasco/Churrasquito/Cazuela/Huevo adicional" "$(q s1 "$(ml "in ('Churrasco','Churrasquito / especial','Cazuela de mariscos','Huevo adicional')")")" "Cazuela de mariscos:Mixtura de mariscos 400 g=1.000,Churrasco:Lomo de res 400 g=1.000,Churrasquito / especial:Lomo de res 200 g=1.000,Huevo adicional:Huevo=1.000"
ck "S1 productos por insumo (res130:2+2 -> 5 con tabla/picada)" "$(q s1 "select count(*) from public.product_bom pb join public.materials m on m.id=pb.material_id where m.name='Lomo de res 130 g'")" 4
ck "S1 sin existencias ni movimientos ni reservas de insumos" "$(q s1 "select (select count(*) from public.material_movements) + (select count(*) from public.material_stock) + (select count(*) from public.material_reservations)")" 0
ck "S1 la linea sigue en el carrito" "$(q s1 "select count(*) from public.cart_items where cart_id='c0000000-0000-0000-0000-000000000001'")" 1
ck "S1 disponible de Churrasco = 0 (insumo sin existencias)" "$(q s1 "select available from public.stock_availability_rows('$T', array[(select id from public.products where name='Churrasco' and tenant_id='$T')])")" 0
grep 'NOTICE' "$WORK/run_s1.txt" | sed 's/^/        /'
# ===== S2: idempotencia =====
ID1=$(q s1 "select md5(string_agg(name||id::text, ',' order by name)) from public.materials where deleted_at is null"); B1=$(q s1 "$SNAPB")
run s1; ck "S2 segunda corrida sin error" "$?" 0
ck "S2 mismos insumos vivos (ids estables)" "$(q s1 "select md5(string_agg(name||id::text, ',' order by name)) from public.materials where deleted_at is null")" "$ID1"
ck "S2 conteos iguales (42 fichas, 10 retirados, 31 filas)" "$(q s1 "select (select count(*) from public.product_bom) || '/' || (select count(*) from public.materials where deleted_at is not null) || '/' || (select count(*) from public.materials where tenant_id='$T')")" "42/10/31"
# ===== S3: efecto en la cuenta POS abierta =====
# Con los insumos en 0 el guardado de una cuenta con productos recipe se RECHAZA (409 de stock de insumos), asi que
# no se pueden crear reservas de insumos: material_reservations queda vacia y la guarda dura no bloquea.
mk s3
q s3 "select public.save_cart_lines('c0000000-0000-0000-0000-000000000001', '$T', '{}'::jsonb, jsonb_build_array(jsonb_build_object('product_id', (select id from public.products where name='Churrasco' and tenant_id='$T'), 'variant_id', null, 'warehouse_id', null, 'product_name', 'Churrasco', 'sku', null, 'quantity', 2, 'unit_price', 30000)))" >/dev/null 2>&1; RC=$?
ck "S3 re-guardar la cuenta abierta con insumos en 0 es rechazado (estado previo)" "$([ $RC -ne 0 ] && echo si || echo no)" si
ck "S3 sin reservas de insumos" "$(q s3 "select count(*) from public.material_reservations")" 0
run s3; ck "S3 la migracion aplica con la cuenta abierta" "$?" 0
ck "S3 la linea de la cuenta sigue en cart_items" "$(q s3 "select count(*) from public.cart_items where cart_id='c0000000-0000-0000-0000-000000000001'")" 1
ck "S3 sin reservas de insumos tras migrar" "$(q s3 "select count(*) from public.material_reservations")" 0
# ===== abortos (cada uno debe fallar Y dejar insumos y fichas sin cambios) =====
abort() { # id desc sql patron
  local db=$(echo "$1" | tr A-Z a-z); mk "$db"; q "$db" "$3" >/dev/null; local s0 b0s; s0=$(q "$db" "$SNAP"); b0s=$(q "$db" "$SNAPB")
  run "$db"; local rc=$?
  ck "$1 $2: aborta" "$([ $rc -ne 0 ] && echo si || echo no)" si
  ck "$1 mensaje contiene '$4'" "$(grep -c "$4" "$WORK/run_$db.txt")" 1
  ck "$1 sin cambios en insumos ni fichas" "$(q "$db" "$SNAP")/$(q "$db" "$SNAPB")" "$s0/$b0s"
}
abort A1 "nombre de tenant distinto" "update public.tenants set name='Barriles' where id='$T'" "no es Barriles de la sexta"
abort A2 "producto faltante" "delete from public.products where name='Bagre a la criolla' and tenant_id='$T'" "no encontrados"
abort A3 "producto inactivo" "update public.products set is_active=false where name='Mojarra carta' and tenant_id='$T'" "no encontrados"
abort A4 "producto borrado (soft)" "update public.products set deleted_at=now() where name='Huevo adicional' and tenant_id='$T'" "no encontrados"
abort A5 "nombre ambiguo" "insert into public.products(tenant_id,name) values ('$T','Cazuela de mariscos')" "ambiguos"
abort A6 "producto con variantes" "update public.products set inventory_mode='stock' where name='Trucha al ajillo' and tenant_id='$T'; update public.products set has_variants=true where name='Trucha al ajillo' and tenant_id='$T'" "con variantes"
abort A7 "insumo nuevo preexistente con unidad kg" "insert into public.materials(tenant_id,name,unit) values ('$T','Trucha 300 g','kg')" "unidad inesperada"
abort A8 "insumo viejo preexistente que no esta en kg" "update public.materials set unit='un' where name='Bagre' and tenant_id='$T'" "unidad inesperada"
abort A9 "existencias de un insumo" "insert into public.material_stock(tenant_id,material_id,warehouse_id,quantity) select '$T', (select id from public.materials where name='Trucha' and tenant_id='$T'), (select id from public.warehouses where tenant_id='$T' limit 1), 5" "material_stock"
abort A10 "movimiento de un insumo" "insert into public.material_movements(tenant_id,material_id,warehouse_id,movement_type,quantity) select '$T', (select id from public.materials where name='Huevo' and tenant_id='$T'), (select id from public.warehouses where tenant_id='$T' limit 1), 'carga_inicial', 3; delete from public.material_stock" "material_movements"
abort A11 "reserva de un insumo" "insert into public.material_reservations(tenant_id,cart_id,material_id,quantity) values ('$T','c0000000-0000-0000-0000-000000000001',(select id from public.materials where name='Chorizo' and tenant_id='$T'),1)" "material_reservations"
abort A12 "producto fuera de la lista usa un insumo viejo" "insert into public.product_bom(tenant_id,product_id,material_id,quantity) select '$T', (select id from public.products where name='Parrillada / campestre' and tenant_id='$T'), (select id from public.materials where name='Trucha' and tenant_id='$T'), 1" "fuera de la lista"
abort A13 "nombre de producto con otra capitalizacion no sirve" "update public.products set name='churrasco' where name='Churrasco' and tenant_id='$T'; delete from public.products where name='churrasco ' and tenant_id='$T'" "no encontrados"

if [ -z "${NO_MUT:-}" ]; then
  echo "== mutaciones (cada una debe terminar con exit 1)"
  mut() { local id=$1 desc=$2 expr=$3 port=$4
    sed "$expr" "$MIG" > "$WORK/mut_$id.sql"
    if cmp -s "$WORK/mut_$id.sql" "$MIG"; then echo "FAIL  $id la mutacion no se aplico" | tee -a "$LOG"; return; fi
    env NO_MUT=1 PGPORT_TEST=$port MIG="$WORK/mut_$id.sql" "$0" > "$WORK/mut_$id.out" 2>&1; local rc=$?
    [ $rc -eq 1 ] && echo "PASS  $id la prueba detecta la mutacion ($desc)" | tee -a "$LOG" || echo "FAIL  $id la prueba NO detecto la mutacion ($desc) rc=$rc" | tee -a "$LOG"; }
  mut X1 "sin guarda de material_stock" "s/if exists (\$/if false and exists (/" 54462
  mut X2 "retira tambien los insumos manuales kg (sin filtrar por nombre)" "/and lower(m.name) in (select lower(name) from _fp_old);/s/ and lower(m.name) in (select lower(name) from _fp_old);/;/" 54463
  mut X3 "cantidad equivocada en una ficha" "s/('Churrasco', 'Lomo de res 400 g', 1)/('Churrasco', 'Lomo de res 400 g', 2)/" 54464
  mut X4 "no borra las fichas previas" "s/^  delete from public.product_bom pb\$/  delete from public.product_bom pb where false and pb.id is null/" 54465
fi
summary
