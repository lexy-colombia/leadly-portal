-- Barriles de la sexta: puesta a cero del inventario de productos (pedido explícito del usuario,
-- 2026-10-27: "elimina el inventario de todos los productos, déjalos en 0 para empezar a ajustarlo").
--
-- No se borran filas ni se toca el kardex existente: por cada fila de product_stock con cantidad > 0
-- se inserta un movimiento 'ajuste_negativo' por la cantidad completa. El trigger apply_stock_movement
-- deja product_stock en 0 y el kardex conserva la historia y el motivo.
-- Solo afecta a este tenant (id fijo) y aborta si algo no queda en cero.

do $$
declare
  v_tenant uuid := '9c79437d-1c19-4edc-bc1f-0dc06094823a';
  v_name text;
  v_ins int;
  v_left int;
begin
  select name into v_name from public.tenants where id = v_tenant;
  if v_name is distinct from 'Barriles de la sexta' then
    raise exception 'Guarda: el tenant % no es Barriles de la sexta (%).', v_tenant, v_name;
  end if;

  insert into public.stock_movements
    (tenant_id, product_id, variant_id, warehouse_id, movement_type, quantity, reference_type, notes)
  select ps.tenant_id, ps.product_id, ps.variant_id, ps.warehouse_id,
         'ajuste_negativo', ps.quantity, 'ajuste_manual',
         'Puesta a cero de inventario (reinicio solicitado por el cliente)'
  from public.product_stock ps
  where ps.tenant_id = v_tenant and ps.quantity > 0;
  get diagnostics v_ins = row_count;

  select count(*) into v_left
  from public.product_stock
  where tenant_id = v_tenant and quantity <> 0;

  if v_left <> 0 then
    raise exception 'Guarda: quedaron % filas de product_stock distintas de cero.', v_left;
  end if;

  raise notice 'Barriles: % movimientos de puesta a cero; inventario en 0.', v_ins;
end $$;
