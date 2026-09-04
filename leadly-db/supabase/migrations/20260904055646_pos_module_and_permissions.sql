alter table public.tenant_enabled_modules drop constraint tenant_enabled_modules_module_key_check;
alter table public.tenant_enabled_modules add constraint tenant_enabled_modules_module_key_check check (module_key in (
  'dashboard', 'conversations', 'contacts', 'pipeline', 'products', 'sales',
  'tasks', 'calendar', 'campaigns', 'reports', 'automations', 'aiAgents',
  'billing', 'integrations', 'inventory', 'settings', 'credit', 'dispatches', 'returns',
  'einvoicing', 'pos'
));

insert into public.permission_actions (key, module_key, name, description, display_order) values
  ('pos.view', 'pos', 'Ver POS', 'Abrir la pantalla de punto de venta', 1),
  ('pos.checkout', 'pos', 'Cobrar en POS', 'Registrar una venta y su pago desde el POS', 2);
