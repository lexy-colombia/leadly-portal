-- Decisión explícita del usuario 2026-08-25: sacar del todo reserva/
-- liberacion_reserva/salida_despacho/entrega_despacho del sistema (no solo
-- dejar de generarlos, como en 20260825134917). Estas 8 filas eran las
-- únicas que existían con esos tipos -- kardex de prueba del 2026-08-23
-- sobre 2 productos, de cuando Despachos todavía tocaba stock. Antes de
-- borrarlas se recalcula product_stock de esos 2 productos reproduciendo
-- el resto de su historial real (entrada/devolucion_danada), para que las
-- cantidades sigan siendo correctas sin depender de las filas que se van.

update public.product_stock set quantity = 21, reserved_quantity = 0
where product_id = '97871675-8967-4350-85dd-6d7f46b1f277'
  and warehouse_id = '62400a2c-1a08-4964-92aa-114d0d0214c4'
  and variant_id is null;

update public.product_stock set quantity = 83, reserved_quantity = 0
where product_id = '618dc418-e04b-40aa-a2c3-be61e2d1c8f3'
  and warehouse_id = '62400a2c-1a08-4964-92aa-114d0d0214c4'
  and variant_id is null;

delete from public.stock_movements
where movement_type in ('reserva', 'liberacion_reserva', 'salida_despacho', 'entrega_despacho');

-- Con la tabla ya libre de esos valores, se pueden sacar de la validación.
alter table public.stock_movements drop constraint stock_movements_movement_type_check;
alter table public.stock_movements add constraint stock_movements_movement_type_check
  check (movement_type = any (array[
    'entrada', 'salida', 'ajuste_positivo', 'ajuste_negativo',
    'transferencia_salida', 'transferencia_entrada',
    'ajuste_dano', 'reversion_dano', 'entrada_devolucion', 'devolucion_danada'
  ]));

-- apply_stock_movement() se queda sin las 4 ramas que ya nunca se van a
-- disparar -- ninguna combinación de columnas que insertaba estos tipos
-- (el trigger de despachos) sigue existiendo.
create or replace function public.apply_stock_movement()
returns trigger
language plpgsql
as $function$
declare
  v_available_delta numeric := 0;
  v_reserved_delta numeric := 0;
  v_departure_delta numeric := 0;
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
$function$;
