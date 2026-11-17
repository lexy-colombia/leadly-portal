-- F1 / S1.7 — Candado acotado: "orden facturada = inmutable" SOLO para los
-- campos de comprador y destino.
--
-- Parte de progress/pendiente_no_aplicar/20261006160000_sales_order_dian_lock.sql
-- (probado 13/13), pero se reduce el alcance: bloquea cambiar contact_id,
-- billing_profile_id, shipping_address_id y shipping_snapshot de un pedido con
-- factura 'sent'/'accepted' no acreditada por completo con notas crédito.
-- NO bloquea: status, delivery_status, pagos, ítems ni ninguna otra columna
-- (eso queda en el archivo pendiente, decisión del usuario).
--
-- Sin bypass para service_role ni superadmin, igual que el original: la regla
-- vale para todos los caminos; una reparación legítima debe deshabilitar el
-- trigger de forma explícita y auditable. Con la factura totalmente acreditada
-- el pedido se desbloquea (flujo "corregir y re-emitir").
--
-- Nombres distintos a los del archivo pendiente (sales_order_is_dian_locked se
-- repite idéntica con create or replace; el trigger es otro), para que aplicar
-- luego el candado completo no choque.

create or replace function public.sales_order_is_dian_locked(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.sales_invoices i
    where i.order_id = p_order_id
      and i.status in ('sent', 'accepted')
      and coalesce((
        select sum(cn.total)
        from public.sales_credit_notes cn
        where cn.invoice_id = i.id and cn.status in ('sent', 'accepted')
      ), 0) + 0.01 < i.total
  );
$$;

revoke execute on function public.sales_order_is_dian_locked(uuid) from public, anon, authenticated;

create or replace function public.guard_sales_order_billing_shipping_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.sales_order_is_dian_locked(old.id) then
    raise exception 'Esta orden ya fue facturada ante la DIAN: el cliente, el perfil de facturación y el destino no se pueden modificar. Para corregirla, emite una nota crédito.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_sales_order_billing_shipping_lock() from public, anon, authenticated;

create trigger trg_sales_orders_billing_shipping_lock
  before update of contact_id, billing_profile_id, shipping_address_id, shipping_snapshot
  on public.sales_orders
  for each row
  when (
    old.contact_id is distinct from new.contact_id
    or old.billing_profile_id is distinct from new.billing_profile_id
    or old.shipping_address_id is distinct from new.shipping_address_id
    or old.shipping_snapshot is distinct from new.shipping_snapshot
  )
  execute function public.guard_sales_order_billing_shipping_lock();
