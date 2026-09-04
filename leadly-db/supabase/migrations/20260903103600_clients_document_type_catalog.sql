-- Catálogo oficial de tipos de identificación DIAN (Tabla 3 del Anexo
-- Técnico de Factura Electrónica de Venta v1.9). No se fuerza un CHECK sobre
-- clients.document_type (texto libre existente, poblado conversacionalmente
-- por la IA desde 2026-08-24 -- filas reales pueden no calzar con ningún
-- catálogo limpio). Se agrega en cambio un campo nuevo, específico para lo
-- que exige el XML de la DIAN, completado desde un select curado en el
-- formulario de cliente.
create table public.dian_document_types (
  code text primary key,
  name text not null
);

insert into public.dian_document_types (code, name) values
  ('11', 'Registro civil'),
  ('12', 'Tarjeta de identidad'),
  ('13', 'Cédula de ciudadanía'),
  ('21', 'Tarjeta de extranjería'),
  ('22', 'Cédula de extranjería'),
  ('31', 'NIT'),
  ('41', 'Pasaporte'),
  ('42', 'Documento de identificación extranjero'),
  ('47', 'PEP'),
  ('48', 'PPT'),
  ('50', 'NIT de otro país'),
  ('91', 'NUIP');

alter table public.dian_document_types enable row level security;
create policy dian_document_types_select on public.dian_document_types
  for select to authenticated using (true);
revoke insert, update, delete on public.dian_document_types from anon, authenticated;
revoke all on public.dian_document_types from anon;

alter table public.clients add column dian_document_type_code text references public.dian_document_types(code);

comment on column public.clients.dian_document_type_code is 'Tipo de documento en el código oficial que exige el XML de la DIAN -- distinto del document_type de texto libre existente, que queda intacto para no romper datos ya guardados. Se completa desde un select nuevo en el formulario de cliente.';
