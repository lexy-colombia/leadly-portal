-- Nuevo proveedor de integración para facturación electrónica DIAN directa
-- (cada tenant es su propio facturador, no Leadly como Proveedor
-- Tecnológico). Reusa el catálogo/patrón de credenciales ya existente
-- (integration_providers/integration_credentials/integration_credential_secrets)
-- tal cual usan Wompi/LaFactura -- no se toca la fila 'lafactura' ya
-- sembrada (queda inerte, de un plan anterior descartado).
insert into public.integration_providers (key, name, category, description) values
  ('dian_directo', 'Facturación electrónica DIAN', 'invoicing',
   'Cada tenant es su propio facturador electrónico ante la DIAN -- trae su propio certificado y resolución; Leadly construye y firma el XML pero nunca actúa como Proveedor Tecnológico.');
