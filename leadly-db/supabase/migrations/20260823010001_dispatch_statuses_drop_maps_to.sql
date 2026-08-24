-- Feedback del usuario 2026-08-23, mismo día de 20260823000001_dispatches.sql:
-- tener un select aparte para "a cuál de los 3 estados de envío legado
-- equivale este estado" (maps_to_delivery_status) además del select de
-- stock_effect era redundante y confuso -- dos formas de decir casi lo
-- mismo. Se saca ese select del todo: sales_orders.delivery_status (el
-- badge de 3 valores fijos que sigue usando la lista de Órdenes) ahora se
-- deriva automáticamente de stock_effect (reserve->pendiente,
-- ship->en_camino, deliver->entregado, none->no lo toca), sin que el
-- tenant tenga que mapear nada a mano. Y en la propia orden, "Estado de
-- envío" deja de mostrar ese bucket traducido -- muestra el nombre real
-- del estado de despacho que el tenant configuró (ver DispatchDrawer/
-- OrderDetail.tsx, cambio de frontend en el mismo paso).

alter table public.dispatch_statuses drop column maps_to_delivery_status;

create or replace function public.apply_dispatch_stock_and_delivery_effect()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_effect text;
  v_maps_to text;
  v_item record;
begin
  select stock_effect into v_effect
    from public.dispatch_statuses where id = new.status_id;

  v_maps_to := case v_effect
    when 'reserve' then 'pendiente'
    when 'ship' then 'en_camino'
    when 'deliver' then 'entregado'
    else null
  end;

  if v_effect in ('reserve', 'ship', 'deliver') and new.stock_stage = 'none' then
    for v_item in
      select product_id, variant_id, warehouse_id, quantity
      from public.sales_order_items
      where order_id = new.sales_order_id and product_id is not null and warehouse_id is not null
    loop
      insert into public.stock_movements (tenant_id, product_id, variant_id, warehouse_id, movement_type, quantity, reference_type, reference_id, created_by)
      values (new.tenant_id, v_item.product_id, v_item.variant_id, v_item.warehouse_id, 'reserva', v_item.quantity, 'despacho', new.id, new.created_by);
    end loop;
    new.stock_stage := 'reserved';
  end if;

  if v_effect in ('ship', 'deliver') and new.stock_stage = 'reserved' then
    for v_item in
      select product_id, variant_id, warehouse_id, quantity
      from public.sales_order_items
      where order_id = new.sales_order_id and product_id is not null and warehouse_id is not null
    loop
      insert into public.stock_movements (tenant_id, product_id, variant_id, warehouse_id, movement_type, quantity, reference_type, reference_id, created_by)
      values (new.tenant_id, v_item.product_id, v_item.variant_id, v_item.warehouse_id, 'salida_despacho', v_item.quantity, 'despacho', new.id, new.created_by);
    end loop;
    new.stock_stage := 'shipped';
  end if;

  if v_effect = 'deliver' and new.stock_stage = 'shipped' then
    for v_item in
      select product_id, variant_id, warehouse_id, quantity
      from public.sales_order_items
      where order_id = new.sales_order_id and product_id is not null and warehouse_id is not null
    loop
      insert into public.stock_movements (tenant_id, product_id, variant_id, warehouse_id, movement_type, quantity, reference_type, reference_id, created_by)
      values (new.tenant_id, v_item.product_id, v_item.variant_id, v_item.warehouse_id, 'entrega_despacho', v_item.quantity, 'despacho', new.id, new.created_by);
    end loop;
    new.stock_stage := 'delivered';
  end if;

  if v_maps_to is not null then
    update public.sales_orders set delivery_status = v_maps_to where id = new.sales_order_id;
  end if;

  return new;
end;
$$;

create or replace function public.seed_default_dispatch_statuses()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.dispatch_statuses (tenant_id, name, color, display_order, stock_effect, is_terminal) values
    (new.id, 'Preparando', '#F59E0B', 0, 'reserve', false),
    (new.id, 'Despachado', '#3B82F6', 1, 'ship', false),
    (new.id, 'En camino', '#6366F1', 2, 'none', false),
    (new.id, 'Entregado', '#10B981', 3, 'deliver', true),
    (new.id, 'Devuelto', '#EF4444', 4, 'none', true);
  return new;
end;
$$;
