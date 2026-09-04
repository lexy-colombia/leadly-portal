-- Catálogo de tipos de impuesto/retención para facturación electrónica DIAN.
-- Códigos tomados de la Tabla 11 ("Tipos de Impuesto") del Anexo Técnico de
-- la Factura Electrónica de Venta v1.9 de la DIAN (Resolución 000165/2023).
-- Solo se siembran los códigos relevantes al perfil de negocio actual de los
-- tenants (retail/servicios) -- agregar uno nuevo (bolsas plásticas, carbono,
-- combustibles, etc.) es una migración aditiva de una fila cuando haga falta,
-- mismo criterio que el catálogo de permission_actions.
--
-- `applies_at` distingue los impuestos que se calculan por línea de producto
-- ('line': IVA/IC/ICA/INC, van en el bloque TaxTotal del XML UBL) de las
-- retenciones que se calculan a nivel de la factura completa ('invoice':
-- ReteIVA/ReteFuente/ReteICA, van en el bloque WithholdingTaxTotal, separado
-- estructuralmente de TaxTotal en el XML).
create table public.tax_types (
  code text primary key,
  name text not null,
  category text not null check (category in ('impuesto', 'retencion')),
  applies_at text not null check (applies_at in ('line', 'invoice')),
  is_active boolean not null default true
);

insert into public.tax_types (code, name, category, applies_at) values
  ('01', 'IVA', 'impuesto', 'line'),
  ('02', 'Impuesto al Consumo (genérico)', 'impuesto', 'line'),
  ('03', 'ICA', 'impuesto', 'line'),
  ('04', 'Impuesto Nacional al Consumo (INC)', 'impuesto', 'line'),
  ('05', 'ReteIVA', 'retencion', 'invoice'),
  ('06', 'ReteFuente', 'retencion', 'invoice'),
  ('07', 'ReteICA', 'retencion', 'invoice');

alter table public.tax_types enable row level security;

create policy tax_types_select on public.tax_types
  for select to authenticated using (true);

revoke insert, update, delete on public.tax_types from anon, authenticated;
revoke all on public.tax_types from anon;
