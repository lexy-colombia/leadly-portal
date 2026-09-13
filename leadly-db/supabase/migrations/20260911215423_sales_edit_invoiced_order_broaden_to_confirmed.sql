-- Amplía el alcance de `sales.edit_invoiced_order` (20260911190000): el
-- usuario probó el permiso contra un pedido real ya confirmado pero SIN
-- factura todavía, y encontró que seguía bloqueado igual -- el candado de
-- "venta ya confirmada" (sales_orders.status <> 'cotizacion') es un
-- candado MÁS AMPLIO y anterior (2026-09-04) al de factura DIAN, y es
-- justo el caso real que necesita resolver: "pedidos como este son
-- exactamente la necesidad que tengo". Mismo permiso, sin agregar uno
-- nuevo -- ahora cubre las dos situaciones (confirmada sin facturar, y
-- facturada) con el mismo criterio: bloqueado sin el permiso, salvo que
-- siga siendo cotización (nunca necesitó permiso). Despachado o anulado
-- sigue sin excepción para nadie, sin cambios.
update public.permission_actions
set
  name = 'Editar pedido confirmado',
  description = 'Cambiar el cliente o los pagos de un pedido ya confirmado (con o sin factura DIAN) -- no aplica a pedidos despachados o anulados, que siguen bloqueados siempre.'
where key = 'sales.edit_invoiced_order';

-- Encapsula el mismo criterio que calculate-order/index.ts aplica del
-- lado del servidor para el titular, reusado acá para pagos -- una sola
-- función en vez de repetir el mismo JOIN en las 3 policies de abajo.
create or replace function public.can_edit_confirmed_sales_order(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    -- Despachado o anulado: sin excepción para nadie.
    not exists (
      select 1
      from public.sales_orders so
      left join public.dispatches d on d.sales_order_id = so.id
      where so.id = p_order_id
        and (so.status = 'cancelada' or d.id is not null or so.delivery_status <> 'pendiente')
    )
    and (
      -- Cotización: siempre editable, nunca necesitó permiso.
      exists (select 1 from public.sales_orders so where so.id = p_order_id and so.status = 'cotizacion')
      or public.has_permission('sales.edit_invoiced_order')
    );
$$;

grant execute on function public.can_edit_confirmed_sales_order(uuid) to authenticated;

drop policy if exists sales_order_payments_insert on public.sales_order_payments;
create policy sales_order_payments_insert on public.sales_order_payments
  for insert with check (
    (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
    and public.can_edit_confirmed_sales_order(order_id)
  );

drop policy if exists sales_order_payments_update on public.sales_order_payments;
create policy sales_order_payments_update on public.sales_order_payments
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (
    (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
    and public.can_edit_confirmed_sales_order(order_id)
  );

drop policy if exists sales_order_payments_delete on public.sales_order_payments;
create policy sales_order_payments_delete on public.sales_order_payments
  for delete using (
    (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
    and public.can_edit_confirmed_sales_order(order_id)
  );
