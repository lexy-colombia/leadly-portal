-- Widens the category catalog and adds Wompi/Shopify/HubSpot as cards in the
-- Integraciones module, per the user's request to mirror the
-- suppliers-web/tania-functions integrations UI (a card + "Conectar" per
-- provider). Wompi is a special case: its real credential storage stays in
-- tenant_payment_credentials (the module that actually powers checkout/
-- webhooks) -- this row only makes it show up as a card; the drawer behind
-- it reads/writes the existing platform Wompi functions, not
-- integration_credentials. Shopify and HubSpot are mapped like LaFactura --
-- credential storage is real (integration_credentials + Vault secrets), no
-- Edge Function calls their API yet.
alter table public.integration_providers drop constraint integration_providers_category_check;
alter table public.integration_providers add constraint integration_providers_category_check
  check (category in ('invoicing', 'accounting', 'messaging', 'payments', 'crm', 'ecommerce', 'other'));

insert into public.integration_providers (key, name, category, description) values
  ('wompi', 'Wompi', 'payments', 'Pasarela de pagos para Colombia. Ya está integrado y en uso real para el cobro de facturas -- esta tarjeta abre la misma configuración de siempre.'),
  ('shopify', 'Shopify', 'ecommerce', 'Tienda en línea. Integración mapeada -- todavía no hay sincronización real de productos/pedidos.'),
  ('hubspot', 'HubSpot', 'crm', 'CRM y marketing. Integración mapeada -- todavía no hay sincronización real de contactos/negocios.');
