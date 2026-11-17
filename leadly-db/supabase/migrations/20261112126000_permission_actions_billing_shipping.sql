-- F2 / permisos de la feature direcciones de entrega + perfiles de facturación.
--
--  * contacts.edit_billing  — crear/editar/borrar perfiles de facturación de un
--    cliente. HOY quien edita los datos fiscales de un cliente lo hace con
--    contacts.edit (formulario del cliente), así que el backfill se la da a todo
--    rol que ya tiene contacts.edit: nadie pierde una capacidad que tenía.
--    Enforcement: SOLO de UI (S5). No existe RLS por permiso todavía (hito 5 de
--    Roles y permisos): las policies de client_billing_profiles son por tenant.
--  * sales.correct_shipping — corregir el destino de un pedido YA confirmado
--    (queda en sales_order_shipping_corrections). Es una capacidad NUEVA: hoy
--    calculate-order ignora el cambio de dirección en un pedido confirmado, o
--    sea que nadie la tenía. Por ser sensible (cambia a dónde se despacha) se
--    otorga solo a los roles que ya tienen sales.edit_invoiced_order (el mismo
--    nivel de confianza: editar un pedido ya confirmado/facturado). Ese permiso
--    nunca se backfilleó a todos, así que normalmente no se concede nada y el
--    tenant_admin decide desde el editor de roles. tenant_admin/superadmin
--    pasan siempre vía has_permission(). Enforcement: Edge Function
--    calculate-order (rpc has_permission), no solo UI.
insert into public.permission_actions (key, module_key, name, description, display_order) values
  ('contacts.edit_billing', 'contacts', 'Editar perfiles de facturación', 'Crear, editar y eliminar los perfiles de facturación (datos fiscales) de un cliente.', 6),
  ('sales.correct_shipping', 'sales', 'Corregir envío de pedido confirmado', 'Cambiar la dirección de entrega de un pedido ya confirmado, dejando registro del motivo. No aplica a pedidos despachados, anulados o con factura transmitida.', 8)
on conflict (key) do nothing;

insert into public.tenant_role_permissions (tenant_role_id, action_key)
select tenant_role_id, 'contacts.edit_billing'
from public.tenant_role_permissions
where action_key = 'contacts.edit'
on conflict do nothing;

insert into public.tenant_role_permissions (tenant_role_id, action_key)
select tenant_role_id, 'sales.correct_shipping'
from public.tenant_role_permissions
where action_key = 'sales.edit_invoiced_order'
on conflict do nothing;
