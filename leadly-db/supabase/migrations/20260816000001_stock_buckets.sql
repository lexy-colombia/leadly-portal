-- Inventario Fase 1: evoluciona product_stock/stock_movements de 2 estados
-- (quantity/reserved_quantity) a 4, adaptando el modelo de Seeri
-- (Desktop/Seeri/products -- ProductEntity/ProductWarehouse tienen
-- stock_available/stock_reserved/stock_departure/stock_damaged, y
-- ProductMovementEntity registra cada movimiento como una transición entre
-- esos 4 estados). Seguro de aplicar ahora porque 20260815000001 todavía
-- está sin usar por ningún frontend/Edge Function -- estas tablas están
-- vacías en producción.
--
-- Por qué los 2 estados nuevos:
-- - departure_quantity: mercancía ya separada/alistada para un despacho,
--   ni disponible para vender ni parte de una reserva -- sin esto, Fase 2
--   (Despachos) no tiene dónde reflejar "esto ya salió de la bodega pero
--   el cliente todavía no lo recibió".
-- - damaged_quantity: mercancía dañada/no vendible, separada del stock
--   disponible sin haber salido del inventario físico del tenant.
--
-- No se adapta el patrón source/destiny de Seeri (dos columnas en cada
-- movimiento) -- se prefiere seguir con un solo movement_type con nombre
-- explícito por transición, consistente con el resto del kardex ya
-- construido (más fácil de leer en español que dos columnas de bucket).

alter table public.product_stock
  add column departure_quantity numeric not null default 0,
  add column damaged_quantity numeric not null default 0;

comment on column public.product_stock.quantity is 'Disponible para vender/reservar (equivalente a stock_available en Seeri).';
comment on column public.product_stock.reserved_quantity is 'Retenido por cotizaciones abiertas -- no disponible, todavía en la bodega.';
comment on column public.product_stock.departure_quantity is 'Alistado/en camino de un despacho -- ya no está en la bodega para efectos de venta, pero el tenant lo sigue teniendo hasta que se entregue.';
comment on column public.product_stock.damaged_quantity is 'Dañado/no vendible -- sigue físicamente en la bodega pero fuera de circulación.';

alter table public.stock_movements drop constraint stock_movements_movement_type_check;
alter table public.stock_movements add constraint stock_movements_movement_type_check check (movement_type in (
  'entrada', 'salida', 'ajuste_positivo', 'ajuste_negativo',
  'transferencia_salida', 'transferencia_entrada',
  'reserva', 'liberacion_reserva',
  'salida_despacho', 'entrega_despacho',
  'ajuste_dano', 'reversion_dano'
));

comment on constraint stock_movements_movement_type_check on public.stock_movements is
  'entrada/salida/ajuste_*/transferencia_*: mueven quantity (disponible). '
  'reserva: disponible -> reservado. liberacion_reserva: reservado -> disponible. '
  'salida_despacho: reservado -> en_despacho. entrega_despacho: en_despacho -> fuera de inventario. '
  'ajuste_dano: disponible -> dañado. reversion_dano: dañado -> disponible.';

-- Reescribe el trigger para mover el par de buckets correcto según
-- movement_type, en vez de solo sumar/restar quantity.
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

  insert into public.product_stock (tenant_id, product_id, warehouse_id, quantity, reserved_quantity, departure_quantity, damaged_quantity)
  values (new.tenant_id, new.product_id, new.warehouse_id, greatest(0, v_available_delta), greatest(0, v_reserved_delta), greatest(0, v_departure_delta), greatest(0, v_damaged_delta))
  on conflict (product_id, warehouse_id)
  do update set
    quantity = greatest(0, public.product_stock.quantity + v_available_delta),
    reserved_quantity = greatest(0, public.product_stock.reserved_quantity + v_reserved_delta),
    departure_quantity = greatest(0, public.product_stock.departure_quantity + v_departure_delta),
    damaged_quantity = greatest(0, public.product_stock.damaged_quantity + v_damaged_delta),
    updated_at = now();

  return new;
end;
$$;
