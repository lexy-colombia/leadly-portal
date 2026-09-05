-- Bug real encontrado 2026-09-05 al limpiar pedidos de prueba (#28000/#28001
-- y #1/#2 de "TecnoNova Colombia"): confirmar una venta descuenta stock real
-- vía un trigger (apply_sales_order_confirmed_stock_effect, migración
-- 20260825134917_simplify_stock_effects_venta_only.sql) pero cancelar una
-- venta YA confirmada nunca lo revertía -- no existía ningún trigger para la
-- transición confirmada/en_proceso/entregada -> cancelada, esa migración
-- solo cubrió el camino de ida. El producto quedaba permanentemente corto de
-- stock por cada venta que se confirmaba y después se cancelaba. Los 4
-- pedidos ya afectados se corrigieron con SQL administrativo (product_stock
-- ajustado + movimiento 'ajuste_positivo' de kardex para los 2 que se
-- mantienen; los 2 de prueba se borraron enteros) antes de esta migración --
-- acá solo el fix de raíz para que no vuelva a pasar.
--
-- Revierte leyendo el propio kardex (los 'salida'/'venta' que de verdad se
-- insertaron para este pedido), no volviendo a derivar la bodega desde
-- sales_order_items -- ítem.warehouse_id puede ser null y en ese caso el
-- trigger de confirmación usó la bodega por defecto del tenant EN ESE
-- MOMENTO; si esa bodega default cambiara más adelante, re-derivarla en la
-- cancelación revertiría en la bodega equivocada. Leer el movimiento real ya
-- grabado es la única fuente de verdad de "en qué bodega salió".
create or replace function public.apply_sales_order_cancelled_stock_effect()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row record;
begin
  for v_row in
    select product_id, variant_id, warehouse_id, sum(quantity) as quantity
    from public.stock_movements
    where reference_id = new.id and reference_type = 'venta' and movement_type = 'salida'
    group by product_id, variant_id, warehouse_id
  loop
    insert into public.stock_movements (tenant_id, product_id, variant_id, warehouse_id, movement_type, quantity, reference_type, reference_id)
    values (new.tenant_id, v_row.product_id, v_row.variant_id, v_row.warehouse_id, 'entrada', v_row.quantity, 'venta', new.id);
  end loop;
  return new;
end;
$function$;

create trigger trg_sales_orders_cancelled_stock_effect
  after update of status on public.sales_orders
  for each row
  when (new.status = 'cancelada' and old.status in ('confirmada', 'en_proceso', 'entregada'))
  execute function public.apply_sales_order_cancelled_stock_effect();

-- Mismo criterio que apply_sales_order_confirmed_stock_effect (su sibling):
-- SECURITY DEFINER + create/replace deja EXECUTE otorgado al pseudo-rol
-- PUBLIC por default en Postgres -- sin este revoke, anon/authenticated
-- (miembros implícitos de PUBLIC) podrían invocarla directo por RPC
-- (`/rest/v1/rpc/...`), saltándose por completo el trigger real y el
-- chequeo de que el pedido de verdad pasó por esa transición de estado.
-- Ojo: revocar de anon/authenticated puntualmente NO alcanza -- el grant
-- real vive en PUBLIC, hay que revocarlo de ahí (get_advisors lo marcó
-- igual hasta corregir esto).
revoke execute on function public.apply_sales_order_cancelled_stock_effect() from public;
