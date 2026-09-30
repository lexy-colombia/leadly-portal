-- Módulo "Reportes" (balance financiero + reportes de producto), pedido
-- explícito del usuario 2026-09-29. Una sola acción de permiso: el módulo es
-- de solo lectura, sin CRUD, así que no hace falta un `reports.manage`.
--
-- 'reports' ya está reservado en el CHECK de tenant_enabled_modules.module_key
-- desde 20260904055646_pos_module_and_permissions.sql (2026-09-04) y de nuevo
-- en 20260913210000_channels_module_and_permissions.sql -- no se toca ese
-- constraint acá, ya lo permite.
--
-- Mismo criterio que un módulo nuevo sin precursor (POS, ver
-- 20260904055646_pos_module_and_permissions.sql): sin backfill a
-- tenant_enabled_modules ni a tenant_role_permissions de tenants existentes.
-- seed_default_tenant_role() (20260829120000) es dinámica (selecciona todo
-- permission_actions.key), así que todo tenant NUEVO creado después de esta
-- migración ya recibe reports.view en su rol "Agente" por defecto. El
-- superadmin habilita el módulo `reports` por tenant desde el backoffice, y
-- el tenant_admin otorga el permiso a los roles que quiera, manualmente.
insert into public.permission_actions (key, module_key, name, description, display_order) values
  ('reports.view', 'reports', 'Ver reportes', 'Ver el balance financiero y los reportes de productos.', 1);
