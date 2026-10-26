-- `sales_orders.has_invoice` significa "la DIAN recibió/aceptó una factura de
-- verdad" (ver 20260908120000). El código de sendInvoiceToDian la pone en
-- true apenas la factura pasa a 'sent', pero nunca la revierte: si la DIAN
-- la rechaza después, el pedido se quedaba como "facturado". Efecto visible:
-- el total "Facturado" de Órdenes y de Reportes sumaba facturas rechazadas
-- (Barriles de la sexta: 14 pedidos, $634.000 de más sobre lo aceptado).
--
-- Se corrige en la base, no en cada emisor: un trigger deja el flag
-- derivado del estado real de las facturas del pedido (alguna 'sent' o
-- 'accepted'), así aplica sin importar quién escriba la factura. No depende
-- de redesplegar funciones.

create or replace function public.sync_sales_order_has_invoice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_has boolean;
begin
  select exists (
    select 1
    from public.sales_invoices i
    where i.order_id = new.order_id
      and i.status in ('sent', 'accepted')
  ) into v_has;

  update public.sales_orders o
  set has_invoice = v_has
  where o.id = new.order_id
    and o.has_invoice is distinct from v_has;

  return null;
end;
$$;

revoke all on function public.sync_sales_order_has_invoice() from public, anon, authenticated;

drop trigger if exists sales_invoices_sync_has_invoice on public.sales_invoices;
create trigger sales_invoices_sync_has_invoice
  after insert or update of status on public.sales_invoices
  for each row execute function public.sync_sales_order_has_invoice();

-- Backfill: pedidos marcados como facturados que no tienen ninguna factura
-- enviada/aceptada (solo rechazadas/error/pendientes).
do $$
declare
  v_fixed int;
  v_remaining int;
begin
  update public.sales_orders o
  set has_invoice = false
  where o.has_invoice
    and not exists (
      select 1 from public.sales_invoices i
      where i.order_id = o.id and i.status in ('sent', 'accepted')
    );
  get diagnostics v_fixed = row_count;

  -- Y el caso inverso, por simetría (no debería haber ninguno).
  update public.sales_orders o
  set has_invoice = true
  where not o.has_invoice
    and exists (
      select 1 from public.sales_invoices i
      where i.order_id = o.id and i.status in ('sent', 'accepted')
    );

  select count(*) into v_remaining
  from public.sales_orders o
  where o.has_invoice is distinct from exists (
    select 1 from public.sales_invoices i
    where i.order_id = o.id and i.status in ('sent', 'accepted')
  );
  if v_remaining <> 0 then
    raise exception 'has_invoice quedó desalineado en % pedidos', v_remaining;
  end if;

  raise notice 'has_invoice corregido en % pedidos', v_fixed;
end $$;
