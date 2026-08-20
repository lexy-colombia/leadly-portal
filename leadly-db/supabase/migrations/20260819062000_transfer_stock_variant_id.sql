-- Extiende transfer_stock con p_variant_id (default null, mismo patrón que
-- p_notes) para trasladar stock de una variante puntual entre bodegas.
-- IMPORTANTE: no alcanza con "create or replace" agregando el parámetro al
-- final -- eso cambia la firma (6 args -> 7 args) y Postgres lo trata como
-- una función DISTINTA sobrecargada, dejando la vieja de 6 args viva en
-- paralelo. Con ambas vivas, una llamada con los 6 argumentos originales
-- (como hace transferStock() en lib/api/stockMovements.ts hoy) se vuelve
-- AMBIGUA entre las dos (las dos matchean, ambas con sus últimos parámetros
-- por default) y Postgres la rechaza con "function is not unique". Por eso
-- el drop explícito antes de recrear. Firma vieja confirmada contra el
-- proyecto real (pg_proc) antes de escribir esta migración.
drop function public.transfer_stock(uuid, uuid, uuid, uuid, numeric, text);

create or replace function public.transfer_stock(
  p_tenant_id uuid,
  p_product_id uuid,
  p_from_warehouse_id uuid,
  p_to_warehouse_id uuid,
  p_quantity numeric,
  p_notes text default null,
  p_variant_id uuid default null
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

  -- p_variant_id, si viene, tiene que pertenecer al producto indicado --
  -- mismo chequeo que validate_stock_movement_variant hace para el resto
  -- de los inserts en stock_movements, repetido acá porque esta función
  -- inserta directo (security invoker, pero el chequeo de "pertenece al
  -- producto" no es algo que RLS por sí sola pueda validar).
  if p_variant_id is not null and not exists (
    select 1 from public.product_variants where id = p_variant_id and product_id = p_product_id and tenant_id = p_tenant_id and deleted_at is null
  ) then
    raise exception 'Variante inválida';
  end if;

  -- is not distinct from (no "=") -- p_variant_id puede ser null, y
  -- `variant_id = null` siempre da null/false en SQL, nunca matchea la fila
  -- sin variante que sí queremos encontrar acá.
  select quantity into v_available
  from public.product_stock
  where product_id = p_product_id and warehouse_id = p_from_warehouse_id
    and variant_id is not distinct from p_variant_id;

  if coalesce(v_available, 0) < p_quantity then
    raise exception 'Stock insuficiente en la bodega de origen (disponible: %)', coalesce(v_available, 0);
  end if;

  insert into public.stock_movements
    (tenant_id, product_id, warehouse_id, variant_id, movement_type, quantity, reference_type, reference_id, notes, created_by)
  values
    (p_tenant_id, p_product_id, p_from_warehouse_id, p_variant_id, 'transferencia_salida', p_quantity, 'transferencia', v_transfer_id, p_notes, auth.uid());

  insert into public.stock_movements
    (tenant_id, product_id, warehouse_id, variant_id, movement_type, quantity, reference_type, reference_id, notes, created_by)
  values
    (p_tenant_id, p_product_id, p_to_warehouse_id, p_variant_id, 'transferencia_entrada', p_quantity, 'transferencia', v_transfer_id, p_notes, auth.uid());

  return v_transfer_id;
end;
$$;

grant execute on function public.transfer_stock(uuid, uuid, uuid, uuid, numeric, text, uuid) to authenticated;
