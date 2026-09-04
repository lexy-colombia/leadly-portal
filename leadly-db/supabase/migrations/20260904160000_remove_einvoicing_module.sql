-- Elimina 'einvoicing' del catálogo de módulos togglables por tenant --
-- redundante con la propia integración DIAN (feedback explícito del usuario
-- 2026-09-04): la card "Factura DIAN" del pedido ya se gatea sola por si el
-- tenant tiene una credencial activa de 'dian_directo' (ver
-- queueInvoiceGeneration en _shared/invoicing/queueInvoiceGeneration.ts), un
-- flag de módulo aparte no agregaba ningún control real -- solo un
-- interruptor extra que el superadmin tenía que acordarse de prender.
delete from public.tenant_enabled_modules where module_key = 'einvoicing';

alter table public.tenant_enabled_modules drop constraint tenant_enabled_modules_module_key_check;
alter table public.tenant_enabled_modules add constraint tenant_enabled_modules_module_key_check check (module_key in (
  'dashboard', 'conversations', 'contacts', 'pipeline', 'products', 'sales',
  'tasks', 'calendar', 'campaigns', 'reports', 'automations', 'aiAgents',
  'billing', 'integrations', 'inventory', 'settings', 'credit', 'dispatches', 'returns',
  'pos'
));
