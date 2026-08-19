-- Traslado de stock entre bodegas -- hasta ahora StockMovementDrawer solo
-- exponía ajustes de una sola bodega (entrada/salida/ajuste_positivo/
-- ajuste_negativo); transferencia_salida/transferencia_entrada ya existían
-- como movement_type válido (stock_movements_movement_type_check) pero
-- nada en la UI los generaba. Una transferencia real son DOS movimientos
-- (salida en origen, entrada en destino) que tienen que aplicarse juntos o
-- no aplicarse -- dos inserts sueltos desde el cliente dejarían la puerta
-- abierta a que uno falle y el otro no, perdiendo o duplicando stock. Esta
-- función envuelve ambos inserts en una sola llamada (una función completa
-- corre en una sola transacción: si el segundo insert falla, Postgres
-- revierte el primero también).
--
-- security invoker (no definer) a propósito -- cada insert sigue pasando
-- por stock_movements_insert (RLS: tenant_id = auth_active_tenant_id()) tal
-- como si el cliente hubiera hecho los dos inserts por su cuenta, así que
-- no hace falta duplicar esa validación acá.
--
-- v_transfer_id se guarda como reference_id (reference_type='transferencia')
-- en ambas filas -- así el historial puede agruparlas como un solo evento
-- ("10 unidades: Bodega Principal → Local") en vez de mostrar dos líneas
-- sueltas de salida/entrada sin relación visible entre sí.
create or replace function public.transfer_stock(
  p_tenant_id uuid,
  p_product_id uuid,
  p_from_warehouse_id uuid,
  p_to_warehouse_id uuid,
  p_quantity numeric,
  p_notes text default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_transfer_id uuid := gen_random_uuid();
  v_available numeric;
begin
  if p_from_warehouse_id = p_to_warehouse_id then
    raise exception 'La bodega de origen y destino no pueden ser la misma';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'La cantidad debe ser mayor a cero';
  end if;

  if not exists (select 1 from public.warehouses where id = p_from_warehouse_id and tenant_id = p_tenant_id) then
    raise exception 'Bodega de origen inválida';
  end if;

  if not exists (select 1 from public.warehouses where id = p_to_warehouse_id and tenant_id = p_tenant_id) then
    raise exception 'Bodega de destino inválida';
  end if;

  if not exists (select 1 from public.products where id = p_product_id and tenant_id = p_tenant_id) then
    raise exception 'Producto inválido';
  end if;

  select quantity into v_available
  from public.product_stock
  where product_id = p_product_id and warehouse_id = p_from_warehouse_id;

  if coalesce(v_available, 0) < p_quantity then
    raise exception 'Stock insuficiente en la bodega de origen (disponible: %)', coalesce(v_available, 0);
  end if;

  insert into public.stock_movements
    (tenant_id, product_id, warehouse_id, movement_type, quantity, reference_type, reference_id, notes, created_by)
  values
    (p_tenant_id, p_product_id, p_from_warehouse_id, 'transferencia_salida', p_quantity, 'transferencia', v_transfer_id, p_notes, auth.uid());

  insert into public.stock_movements
    (tenant_id, product_id, warehouse_id, movement_type, quantity, reference_type, reference_id, notes, created_by)
  values
    (p_tenant_id, p_product_id, p_to_warehouse_id, 'transferencia_entrada', p_quantity, 'transferencia', v_transfer_id, p_notes, auth.uid());

  return v_transfer_id;
end;
$$;

grant execute on function public.transfer_stock(uuid, uuid, uuid, uuid, numeric, text) to authenticated;
