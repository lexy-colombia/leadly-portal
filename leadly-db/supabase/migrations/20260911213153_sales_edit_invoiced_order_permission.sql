-- Permiso nuevo para una excepción puntual al candado de factura DIAN ya
-- enviada/aceptada: hoy ese candado es total y sin excepción, tanto para
-- editar el cliente de un pedido (calculate-order/index.ts) como -- una
-- vez agregado el candado nuevo más abajo -- para sus pagos
-- (sales_order_payments, que hasta ahora no tenía NINGÚN candado de
-- negocio). Pedido explícito del usuario (2026-09-11): un admin (o quien
-- tenga este permiso puntual) tiene que poder corregir el titular/los
-- pagos de un pedido ya facturado -- los ÍTEMS/PRECIOS siguen sin
-- excepción (desalinearían un documento fiscal ya transmitido), y un
-- pedido despachado o anulado sigue bloqueado siempre, sin excepción,
-- para cualquiera.
--
-- Deliberadamente SIN backfill a ningún tenant_role existente -- a
-- diferencia de conversations.view (20260829150000, que preservaba acceso
-- que ya existía de hecho), esto es una capacidad nueva y sensible: que un
-- tenant_agent la tenga es una decisión explícita del tenant_admin desde
-- el editor de roles, nunca heredada de otro permiso. superadmin/
-- tenant_admin ya la tienen siempre vía has_permission() (is_superadmin()
-- OR is_tenant_admin()), sin necesidad de ninguna fila acá.
insert into public.permission_actions (key, module_key, name, description, display_order) values
  ('sales.edit_invoiced_order', 'sales', 'Editar pedido ya facturado', 'Cambiar el cliente o los pagos de un pedido que ya tiene una factura DIAN enviada o aceptada. No aplica a pedidos despachados o anulados, que siguen bloqueados siempre.', 7);

-- sales_order_payments no tenía NINGÚN candado de negocio -- las 4
-- policies (20260815010005_core_sales.sql) solo exigían tenant_id
-- correcto. Se agrega el mismo criterio que calculate-order/index.ts:
-- bloqueado si el pedido tiene factura DIAN sent/accepted
-- (sales_orders.has_invoice, que solo se pone en true en ese caso exacto
-- -- ver sendInvoiceToDian.ts), salvo que el caller tenga el permiso
-- nuevo. select se deja sin cambios -- ver pagos de un pedido facturado
-- nunca fue el problema, solo crear/editar/borrarlos.
drop policy if exists sales_order_payments_insert on public.sales_order_payments;
create policy sales_order_payments_insert on public.sales_order_payments
  for insert with check (
    (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
    and (
      public.has_permission('sales.edit_invoiced_order')
      or not exists (select 1 from public.sales_orders so where so.id = order_id and so.has_invoice)
    )
  );

drop policy if exists sales_order_payments_update on public.sales_order_payments;
create policy sales_order_payments_update on public.sales_order_payments
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (
    (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
    and (
      public.has_permission('sales.edit_invoiced_order')
      or not exists (select 1 from public.sales_orders so where so.id = order_id and so.has_invoice)
    )
  );

drop policy if exists sales_order_payments_delete on public.sales_order_payments;
create policy sales_order_payments_delete on public.sales_order_payments
  for delete using (
    (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
    and (
      public.has_permission('sales.edit_invoiced_order')
      or not exists (select 1 from public.sales_orders so where so.id = order_id and so.has_invoice)
    )
  );
