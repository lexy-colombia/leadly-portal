-- Colombian electronic invoicing (DIAN) requires the buyer's address on
-- every invoice; tenants has country/state_province but no street address.
-- Nullable/additive, same pattern as 20260802000013_tenant_profile_fields.sql
-- (self_register_tenant never sets it, existing rows predate it).
alter table public.tenants
  add column billing_address text;

comment on column public.tenants.billing_address is 'Dirección física para efectos de facturación (requerida por la DIAN en el comprador de una factura electrónica).';
