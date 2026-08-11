-- Stock lifecycle for cotizaciones/ventas (same crm_orders entity, only
-- `status` differs -- see 20260808000003_crm_orders.sql): a cotización
-- holds (reserves) stock without touching physical inventory yet; once it
-- becomes a real sale (confirmada/en_proceso/entregada) the hold converts
-- into an actual deduction; cancelling a cotización releases the hold;
-- voiding a sale (-> cancelada) restores the deducted stock. Implemented as
-- DB triggers, not app-layer logic, because two independent callers change
-- these rows (the tenant UI and, once the "ventas"/"catalogo" AI skills
-- ship, whatsapp-ai-tools) -- a trigger is the one place this can't drift
-- out of sync between them.
alter table public.crm_products add column reserved_stock integer not null default 0;
comment on column public.crm_products.reserved_stock is 'Held by open cotizaciones (crm_orders.status = cotizacion). Available to sell = stock_quantity - reserved_stock.';

create or replace function public.adjust_product_stock(p_product_id uuid, p_stock_delta integer, p_reserved_delta integer)
returns void
language plpgsql
as $$
begin
  update public.crm_products
  set
    stock_quantity = greatest(0, stock_quantity + p_stock_delta),
    reserved_stock = greatest(0, reserved_stock + p_reserved_delta)
  where id = p_product_id and track_inventory = true;
end;
$$;

-- Fires whenever a line item is added to/removed from an order. Which
-- column it touches depends on the *order's current status* at the moment
-- of the change, not the item's own history:
--   - order still a cotización -> the item is a reservation (reserved_stock)
--   - order already confirmada/en_proceso/entregada -> the item is a real,
--     immediate deduction (stock_quantity) -- covers an order created
--     already-confirmed (e.g. a walk-in/instant sale with no prior quote),
--     which never goes through a reservation phase at all.
--   - order cancelada -> no live stock effect (items on a cancelled order
--     are historical only)
create or replace function public.apply_order_item_stock_effect()
returns trigger
language plpgsql
as $$
declare
  v_row public.crm_order_items;
  v_sign integer;
  v_order_status text;
begin
  if tg_op = 'INSERT' then
    v_row := new;
    v_sign := 1;
  else
    v_row := old;
    v_sign := -1;
  end if;

  if v_row.product_id is null then
    return v_row;
  end if;

  select status into v_order_status from public.crm_orders where id = v_row.order_id;

  if v_order_status = 'cotizacion' then
    perform public.adjust_product_stock(v_row.product_id, 0, v_sign * v_row.quantity::integer);
  elsif v_order_status in ('confirmada', 'en_proceso', 'entregada') then
    perform public.adjust_product_stock(v_row.product_id, v_sign * v_row.quantity::integer, 0);
  end if;

  return v_row;
end;
$$;

create trigger trg_crm_order_items_insert_stock after insert on public.crm_order_items
  for each row execute function public.apply_order_item_stock_effect();
create trigger trg_crm_order_items_delete_stock after delete on public.crm_order_items
  for each row execute function public.apply_order_item_stock_effect();

-- Fires on the status *transition itself* -- the handoff between a
-- reservation and a real deduction, which no item-level event covers
-- because the items table isn't touched during a pure status change.
create or replace function public.apply_order_status_stock_effect()
returns trigger
language plpgsql
as $$
declare
  v_item record;
begin
  if new.status = old.status then
    return new;
  end if;

  if old.status = 'cotizacion' and new.status in ('confirmada', 'en_proceso', 'entregada') then
    for v_item in select product_id, quantity from public.crm_order_items where order_id = new.id and product_id is not null loop
      perform public.adjust_product_stock(v_item.product_id, -v_item.quantity::integer, -v_item.quantity::integer);
    end loop;
  elsif old.status = 'cotizacion' and new.status = 'cancelada' then
    for v_item in select product_id, quantity from public.crm_order_items where order_id = new.id and product_id is not null loop
      perform public.adjust_product_stock(v_item.product_id, 0, -v_item.quantity::integer);
    end loop;
  elsif old.status in ('confirmada', 'en_proceso', 'entregada') and new.status = 'cancelada' then
    for v_item in select product_id, quantity from public.crm_order_items where order_id = new.id and product_id is not null loop
      perform public.adjust_product_stock(v_item.product_id, v_item.quantity::integer, 0);
    end loop;
  end if;

  return new;
end;
$$;

create trigger trg_crm_orders_status_stock after update of status on public.crm_orders
  for each row when (old.status is distinct from new.status) execute function public.apply_order_status_stock_effect();
