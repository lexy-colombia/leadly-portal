-- Al enforzar el permiso de "ver módulo" a nivel de ruta (RequireModule
-- ganó un prop `action` opcional, ver routes/guards.tsx), Conversaciones
-- quedó sin ninguna acción ".view" en el catálogo original -- se habían
-- listado reply/assign/manage_tags/delete pero no la de simplemente poder
-- abrir el Inbox. La agrega acá.
insert into public.permission_actions (key, module_key, name, description, display_order) values
  ('conversations.view', 'conversations', 'Ver conversaciones', 'Abrir el Inbox y ver conversaciones.', 0);

-- Backfill: todo tenant_role que ya podía responder (conversations.reply)
-- obviamente ya debía poder ver -- se le agrega la acción nueva para no
-- perder acceso el día de este deploy. Un rol que nunca tuvo reply
-- tampoco gana view acá (se respeta la restricción existente, si la hay).
insert into public.tenant_role_permissions (tenant_role_id, action_key)
select tenant_role_id, 'conversations.view'
from public.tenant_role_permissions
where action_key = 'conversations.reply';
