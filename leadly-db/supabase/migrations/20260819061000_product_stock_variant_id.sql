-- Variantes, parte 2: product_stock/stock_movements ganan variant_id
-- nullable. El problema real de esta migración: product_stock tenía
-- `unique (product_id, warehouse_id)` -- con variantes, dos filas con
-- variant_id null para el mismo producto+bodega siguen siendo inválidas
-- (producto sin variantes, la regla de siempre), pero dos filas con
-- variant_id DISTINTO para el mismo producto+bodega son perfectamente
-- válidas (dos variantes del mismo producto, cada una con su propio stock
-- por bodega). Un unique constraint normal no puede expresar eso --
-- variant_id nullable rompe la unicidad justo al revés de lo que se
-- necesita (NULL nunca choca con NULL en un índice único).
--
-- Solución: DOS índices únicos PARCIALES, uno por caso, mutuamente
-- excluyentes por predicado. El trigger de abajo elige cuál usar como
-- conflict target según new.variant_id sea null o no -- ON CONFLICT solo
-- puede apuntar a un único índice arbiter por statement, así que hacen
-- falta dos INSERTs completos en una rama IF/ELSE, no un único INSERT con
-- un conflict target condicional -- Postgres no lo permite.

alter table public.product_stock
  add column variant_id uuid references public.product_variants(id) on delete cascade;

alter table public.stock_movements
  add column variant_id uuid references public.product_variants(id) on delete restrict;

create index product_stock_variant_id_idx on public.product_stock(variant_id);
create index stock_movements_variant_id_idx on public.stock_movements(variant_id);

-- on delete cascade/restrict elegidos para calzar EXACTO con lo que
-- product_id ya hace en cada una de estas dos tablas (cascade en
-- product_stock -- es un snapshot derivable del kardex; restrict en
-- stock_movements -- es append-only, nunca se pierde una fila del
-- historial por un delete en cascada).

-- Reemplaza el unique(product_id, warehouse_id) original. Nombre
-- confirmado contra el proyecto real (pg_constraint) antes de escribir
-- esta migración: product_stock_product_id_warehouse_id_key.
alter table public.product_stock drop constraint product_stock_product_id_warehouse_id_key;

-- Caso "sin variantes" (variant_id is null): la clave sigue siendo
-- product_id+warehouse_id nada más -- variant_id queda FUERA de las
-- columnas del índice a propósito, así Postgres compara solo esas dos
-- columnas entre las filas que matchean el predicado.
create unique index product_stock_no_variant_unique on public.product_stock(product_id, warehouse_id)
  where variant_id is null;

-- Caso "con variante": la clave es product_id+warehouse_id+variant_id.
create unique index product_stock_variant_unique on public.product_stock(product_id, warehouse_id, variant_id)
  where variant_id is not null;

-- Reescribe el trigger para escribir variant_id y elegir el índice de
-- conflicto correcto según el caso -- misma lógica de buckets que
-- 20260816000002_stock_buckets.sql, el INSERT ... ON CONFLICT se duplica
-- por rama (es la única forma correcta, ver nota de arriba).
create or replace function public.apply_stock_movement()
returns trigger
language plpgsql
as $$
declare
  v_available_delta numeric := 0;
  v_reserved_delta numeric := 0;
  v_departure_delta numeric := 0;
  v_damaged_delta numeric := 0;
begin
  case new.movement_type
    when 'entrada', 'ajuste_positivo', 'transferencia_entrada' then
      v_available_delta := new.quantity;
    when 'salida', 'ajuste_negativo', 'transferencia_salida' then
      v_available_delta := -new.quantity;
    when 'reserva' then
      v_available_delta := -new.quantity;
      v_reserved_delta := new.quantity;
    when 'liberacion_reserva' then
      v_available_delta := new.quantity;
      v_reserved_delta := -new.quantity;
    when 'salida_despacho' then
      v_reserved_delta := -new.quantity;
      v_departure_delta := new.quantity;
    when 'entrega_despacho' then
      v_departure_delta := -new.quantity;
    when 'ajuste_dano' then
      v_available_delta := -new.quantity;
      v_damaged_delta := new.quantity;
    when 'reversion_dano' then
      v_available_delta := new.quantity;
      v_damaged_delta := -new.quantity;
  end case;

  if new.variant_id is null then
    insert into public.product_stock (tenant_id, product_id, warehouse_id, variant_id, quantity, reserved_quantity, departure_quantity, damaged_quantity)
    values (new.tenant_id, new.product_id, new.warehouse_id, null, greatest(0, v_available_delta), greatest(0, v_reserved_delta), greatest(0, v_departure_delta), greatest(0, v_damaged_delta))
    on conflict (product_id, warehouse_id) where variant_id is null
    do update set
      quantity = greatest(0, public.product_stock.quantity + v_available_delta),
      reserved_quantity = greatest(0, public.product_stock.reserved_quantity + v_reserved_delta),
      departure_quantity = greatest(0, public.product_stock.departure_quantity + v_departure_delta),
      damaged_quantity = greatest(0, public.product_stock.damaged_quantity + v_damaged_delta),
      updated_at = now();
  else
    insert into public.product_stock (tenant_id, product_id, warehouse_id, variant_id, quantity, reserved_quantity, departure_quantity, damaged_quantity)
    values (new.tenant_id, new.product_id, new.warehouse_id, new.variant_id, greatest(0, v_available_delta), greatest(0, v_reserved_delta), greatest(0, v_departure_delta), greatest(0, v_damaged_delta))
    on conflict (product_id, warehouse_id, variant_id) where variant_id is not null
    do update set
      quantity = greatest(0, public.product_stock.quantity + v_available_delta),
      reserved_quantity = greatest(0, public.product_stock.reserved_quantity + v_reserved_delta),
      departure_quantity = greatest(0, public.product_stock.departure_quantity + v_departure_delta),
      damaged_quantity = greatest(0, public.product_stock.damaged_quantity + v_damaged_delta),
      updated_at = now();
  end if;

  return new;
end;
$$;

-- Trigger de validación cruzada. Corre BEFORE INSERT (antes que
-- apply_stock_movement, que es AFTER INSERT, así que el orden entre ambos
-- nunca es ambiguo) y ataja dos errores de integridad que ni RLS ni las FKs
-- existentes pueden evitar: (a) insertar un movimiento sin variant_id para
-- un producto que sí usa variantes (dejaría stock "invisible" fuera de
-- cualquier variante), y (b) que variant_id apunte a una variante que
-- pertenece a OTRO producto. Es el único punto de esta índole en todo el
-- esquema (stock_movements es append-only e inmutable -- un movimiento mal
-- insertado no se puede corregir después, a diferencia de una fila
-- editable normal), por eso se justifica acá y no en otro lado.
create or replace function public.validate_stock_movement_variant()
returns trigger
language plpgsql
as $$
declare
  v_has_variants boolean;
begin
  select has_variants into v_has_variants from public.products where id = new.product_id;

  if v_has_variants and new.variant_id is null then
    raise exception 'Este producto usa variantes -- el movimiento de stock necesita variant_id';
  end if;

  if not v_has_variants and new.variant_id is not null then
    raise exception 'Este producto no usa variantes -- variant_id debe ser null';
  end if;

  if new.variant_id is not null and not exists (
    select 1 from public.product_variants where id = new.variant_id and product_id = new.product_id
  ) then
    raise exception 'La variante no pertenece a este producto';
  end if;

  return new;
end;
$$;

create trigger trg_stock_movements_validate_variant before insert on public.stock_movements
  for each row execute function public.validate_stock_movement_variant();
