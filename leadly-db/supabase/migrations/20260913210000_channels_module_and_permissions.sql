-- Canales (líneas de WhatsApp) pasa a ser un módulo propio del CRM, con sus
-- permisos, en vez de una pantalla suelta de administrador.
--
-- Contexto (2026-09-13): "IA & Agentes" mezclaba líneas de WhatsApp, agentes
-- de IA y plantillas de Meta. Las líneas salieron a su propia pantalla
-- ("Canales") y las plantillas se fueron a Campañas. Pedido explícito del
-- usuario en la segunda ronda: Canales es parte del CRM, así que tiene que
-- ser un módulo togglable desde el backoffice como el resto (conversaciones,
-- pipeline, campañas, IA) y tener permisos por acción, no quedar fijo y
-- admin-only.
--
-- Dos acciones, mismo criterio que el resto del catálogo: ver (abre la
-- pantalla, es lo que gatea la ruta y el ítem del menú) y gestionar
-- (conectar/desconectar una línea y asignarle agente -- tocar el canal por
-- donde entra todo el negocio no es lo mismo que mirarlo).
--
-- Backfill, para que nadie pierda acceso el día del deploy:
-- - el módulo `channels` se habilita para todo tenant que hoy tenga
--   `aiAgents`, que es donde vivían las líneas hasta hoy;
-- - los dos permisos se otorgan a todo rol que ya tuviera `aiAgents.view`,
--   por la misma razón.

-- La lista de módulos válidos vive en un CHECK de la tabla (ver migración
-- 20260811000001), así que agregar uno nuevo pasa por ampliarlo.
alter table public.tenant_enabled_modules drop constraint if exists tenant_enabled_modules_module_key_check;
alter table public.tenant_enabled_modules add constraint tenant_enabled_modules_module_key_check
  check (module_key = any (array[
    'dashboard', 'conversations', 'channels', 'contacts', 'pipeline', 'products', 'sales', 'tasks',
    'calendar', 'campaigns', 'reports', 'automations', 'aiAgents', 'billing', 'integrations',
    'inventory', 'settings', 'credit', 'dispatches', 'returns', 'pos', 'expenses'
  ]));

insert into public.permission_actions (key, module_key, name, description, display_order)
values
  ('channels.view', 'channels', 'Ver canales', 'Ver las líneas de WhatsApp conectadas y su estado.', 1),
  ('channels.manage', 'channels', 'Gestionar canales', 'Conectar o desconectar líneas de WhatsApp y asignarles agente.', 2)
on conflict (key) do nothing;

insert into public.tenant_enabled_modules (tenant_id, module_key)
select m.tenant_id, 'channels'
from public.tenant_enabled_modules m
where m.module_key = 'aiAgents'
on conflict do nothing;

insert into public.tenant_role_permissions (tenant_role_id, action_key)
select p.tenant_role_id, a.key
from public.tenant_role_permissions p
cross join (values ('channels.view'), ('channels.manage')) as a(key)
where p.action_key = 'aiAgents.view'
on conflict do nothing;
