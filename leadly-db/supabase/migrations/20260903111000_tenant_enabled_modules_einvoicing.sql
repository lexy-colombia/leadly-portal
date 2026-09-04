-- Agrega 'einvoicing' al catálogo de módulos togglables por tenant --
-- "Facturas" es una superficie operativa continua (como Ventas/Devoluciones),
-- merece su propia entrada de nav, separada del drawer de setup en
-- Integraciones.
alter table public.tenant_enabled_modules drop constraint tenant_enabled_modules_module_key_check;
alter table public.tenant_enabled_modules add constraint tenant_enabled_modules_module_key_check check (module_key in (
  'dashboard', 'conversations', 'contacts', 'pipeline', 'products', 'sales',
  'tasks', 'calendar', 'campaigns', 'reports', 'automations', 'aiAgents',
  'billing', 'integrations', 'inventory', 'settings', 'credit', 'dispatches', 'returns',
  'einvoicing'
));
