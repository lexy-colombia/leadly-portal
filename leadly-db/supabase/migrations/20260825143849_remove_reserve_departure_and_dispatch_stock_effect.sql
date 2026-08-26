-- Decisión explícita del usuario 2026-08-25, continuación de
-- 20260825134917/20260825142125: terminar de sacar el concepto de
-- "reserva"/"salida a despacho" del sistema, no solo dejar de generarlo.
--
-- Verificado antes de tocar nada: apply_return_item_stock_effect() (el
-- único otro trigger que escribe en stock_movements/product_stock) solo
-- produce 'entrada_devolucion'/'devolucion_danada', que ya únicamente
-- tocan quantity/damaged_quantity -- reserved_quantity/departure_quantity
-- quedan sin ningún escritor en todo el sistema, se pueden sacar sin dejar
-- nada huérfano.

-- 1. Despachos deja de tener ningún efecto automático (ni stock ni
--    delivery_status) -- delivery_status se sigue pudiendo cambiar a mano
--    (updateDeliveryStatus ya existe en el frontend, independiente de esto
--    desde que se creó).
drop trigger trg_dispatches_stock_and_delivery_effect on public.dispatches;
drop function public.apply_dispatch_stock_and_delivery_effect();

-- 2. Sin ese trigger, la columna que lo configuraba por tenant no sirve
--    para nada.
alter table public.dispatch_statuses drop column stock_effect;

-- 3. Sin nada que las escriba, estos dos buckets de product_stock no
--    aportan nada -- solo quantity (disponible) y damaged_quantity siguen
--    vivos.
alter table public.product_stock drop column reserved_quantity;
alter table public.product_stock drop column departure_quantity;

create or replace function public.apply_stock_movement()
returns trigger
language plpgsql
as $function$
declare
  v_available_delta numeric := 0;
  v_damaged_delta numeric := 0;
begin
  case new.movement_type
    when 'entrada', 'ajuste_positivo', 'transferencia_entrada', 'entrada_devolucion' then
      v_available_delta := new.quantity;
    when 'salida', 'ajuste_negativo', 'transferencia_salida' then
      v_available_delta := -new.quantity;
    when 'ajuste_dano', 'devolucion_danada' then
      v_damaged_delta := new.quantity;
      if new.movement_type = 'ajuste_dano' then
        v_available_delta := -new.quantity;
      end if;
    when 'reversion_dano' then
      v_available_delta := new.quantity;
      v_damaged_delta := -new.quantity;
  end case;

  if new.variant_id is null then
    insert into public.product_stock (tenant_id, product_id, warehouse_id, variant_id, quantity, damaged_quantity)
    values (new.tenant_id, new.product_id, new.warehouse_id, null, greatest(0, v_available_delta), greatest(0, v_damaged_delta))
    on conflict (product_id, warehouse_id) where variant_id is null
    do update set
      quantity = greatest(0, public.product_stock.quantity + v_available_delta),
      damaged_quantity = greatest(0, public.product_stock.damaged_quantity + v_damaged_delta),
      updated_at = now();
  else
    insert into public.product_stock (tenant_id, product_id, warehouse_id, variant_id, quantity, damaged_quantity)
    values (new.tenant_id, new.product_id, new.warehouse_id, new.variant_id, greatest(0, v_available_delta), greatest(0, v_damaged_delta))
    on conflict (product_id, warehouse_id, variant_id) where variant_id is not null
    do update set
      quantity = greatest(0, public.product_stock.quantity + v_available_delta),
      damaged_quantity = greatest(0, public.product_stock.damaged_quantity + v_damaged_delta),
      updated_at = now();
  end if;

  return new;
end;
$function$;
