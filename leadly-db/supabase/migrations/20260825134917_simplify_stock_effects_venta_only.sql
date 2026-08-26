-- Simplificación de arquitectura de stock, decisión explícita del usuario
-- 2026-08-25: la cadena cotización (nada) -> confirmar (reserva, agregado
-- ayer) -> despacho (reserva/salida_despacho/entrega_despacho) resultó
-- confusa y ya estaba parcialmente rota en la práctica (solo 6 de 15 líneas
-- de venta tenían warehouse_id cargado, así que la mitad de los despachos
-- nunca generaban ningún movimiento). Regla nueva, única: **solo una venta
-- confirmada descuenta stock, de verdad, en el momento** -- cotizar no toca
-- nada, despachar tampoco. Además pasa a vivir en un trigger de
-- sales_orders (no en el código de whatsapp-ai-tools) para que aplique
-- igual sin importar si confirma la IA o un agente humano desde
-- OrderDetail.tsx, que hoy no tenía ningún efecto de stock propio.

-- =====================================================================
-- 1. Nuevo trigger: confirmar una venta descuenta stock real (movement_type
--    'salida', no 'reserva' -- eso se revierte del código de ayer, ver
--    whatsapp-ai-tools/index.ts). Usa el warehouse_id de la línea si el
--    humano lo eligió al armar la orden (Orders.tsx sí lo permite), si no
--    cae a la bodega por defecto del tenant.
-- =====================================================================

create or replace function public.apply_sales_order_confirmed_stock_effect()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_item record;
  v_default_warehouse_id uuid;
begin
  select id into v_default_warehouse_id
  from public.warehouses
  where tenant_id = new.tenant_id and is_default = true and is_active = true
  limit 1;

  for v_item in
    select soi.product_id, soi.variant_id, soi.warehouse_id, soi.quantity
    from public.sales_order_items soi
    join public.products p on p.id = soi.product_id
    where soi.order_id = new.id and soi.product_id is not null and p.track_inventory = true
  loop
    insert into public.stock_movements (tenant_id, product_id, variant_id, warehouse_id, movement_type, quantity, reference_type, reference_id)
    values (new.tenant_id, v_item.product_id, v_item.variant_id, coalesce(v_item.warehouse_id, v_default_warehouse_id), 'salida', v_item.quantity, 'venta', new.id);
  end loop;

  return new;
end;
$function$;

create trigger trg_sales_orders_confirmed_stock_effect
  after update of status on public.sales_orders
  for each row
  when (new.status = 'confirmada' and old.status is distinct from new.status)
  execute function public.apply_sales_order_confirmed_stock_effect();

-- =====================================================================
-- 2. Despachos deja de tocar stock -- se queda solo con lo que de verdad
--    le corresponde (sincronizar sales_orders.delivery_status según el
--    stock_effect configurado del estado de despacho). dispatches.stock_stage
--    queda como columna sin uso (no se lee en ningún lado del frontend,
--    solo tipada en domain.ts) -- no se borra en esta migración, no hay
--    urgencia y borrar una columna es más riesgoso que dejarla quieta.
-- =====================================================================

create or replace function public.apply_dispatch_stock_and_delivery_effect()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_effect text;
  v_maps_to text;
begin
  select stock_effect into v_effect
    from public.dispatch_statuses where id = new.status_id;

  v_maps_to := case v_effect
    when 'reserve' then 'pendiente'
    when 'ship' then 'en_camino'
    when 'deliver' then 'entregado'
    else null
  end;

  if v_maps_to is not null then
    update public.sales_orders set delivery_status = v_maps_to where id = new.sales_order_id;
  end if;

  return new;
end;
$function$;

-- =====================================================================
-- 3. Prompt de la habilidad "ventas" actualizado para reflejar la regla
--    nueva (confirm_quote descuenta ahí mismo, ya no reserva).
-- =====================================================================

update public.ai_skills set
  prompt_fragment = replace(
    prompt_fragment,
    'confirm_quote(): sin parámetros. Pasa el pedido de "cotizacion" a "confirmada" y reserva el stock real (de la variante específica, si aplica) contra la bodega principal del tenant -- puede fallar por stock insuficiente. La reserva no es el descuento final: eso sigue pasando recién cuando el pedido se despacha de verdad.',
    'confirm_quote(): sin parámetros. Pasa el pedido de "cotizacion" a "confirmada" y descuenta el inventario real ahí mismo (de la variante específica, si aplica) -- puede fallar por stock insuficiente. Cotizar y despachar no tocan el stock; el único momento en que se descuenta de verdad es este.'
  )
where key = 'ventas';
