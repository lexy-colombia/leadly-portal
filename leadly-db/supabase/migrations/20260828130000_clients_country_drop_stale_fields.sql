-- Pedido explícito del usuario (2026-08-28): el formulario manual de
-- Clientes tenía industria/sitio web/dirección/ciudad -- ninguno se usaba
-- en ningún lado real (ni AI tools, ni reportes, ni la ficha de detalle
-- salvo mostrar la ciudad en el header). La dirección real de envío/
-- facturación ya vive en contact_addresses (múltiples direcciones por
-- cliente, ver 20260815010001_core_contacts.sql) -- clients.address/city
-- era un campo suelto redundante con eso. Se reemplazan por country (mismo
-- criterio que tenants.country: código curado desde COUNTRIES en el
-- frontend, sin catálogo propio en DB) para saber de qué país es el
-- cliente, dato que hoy no existía en ningún lado.
alter table public.clients drop column industry;
alter table public.clients drop column website;
alter table public.clients drop column address;
alter table public.clients drop column city;

alter table public.clients add column country text;
