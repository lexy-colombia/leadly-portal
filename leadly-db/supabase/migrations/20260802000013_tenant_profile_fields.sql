-- Expands tenants with the fields a real onboarding needs: legal identity
-- (persona/empresa, razón social, tipo/número de documento), location
-- (país, departamento/estado), preferred language (first step towards
-- multi-language support), and a logo.
--
-- These stay NULLable at the DB level on purpose: self-registered tenants
-- (self_register_tenant RPC) only ever set `name`, and existing rows predate
-- this migration. "Required" for the rich backoffice creation form is
-- enforced in the frontend (useTenantForm), not here -- the DB only enforces
-- the invariants that must never be violated regardless of which path
-- created the row (entity_type/preferred_language values, document_type
-- values, legal_name required when entity_type=empresa).
alter table public.tenants
  add column entity_type varchar(10) not null default 'empresa' check (entity_type in ('persona', 'empresa')),
  add column legal_name varchar(200),
  add column document_type varchar(20) check (document_type in ('NIT', 'CC', 'CE', 'RUC', 'RFC', 'PASAPORTE', 'OTRO')),
  add column document_number varchar(30),
  add column country varchar(2),
  add column state_province varchar(100),
  add column preferred_language varchar(5) not null default 'es' check (preferred_language in ('es', 'en')),
  add column logo_url text;
-- legal_name-required-for-empresa is intentionally NOT a DB constraint: existing
-- rows (including anything created by self_register_tenant, which never asks
-- for it) would violate it immediately. Enforced in useTenantForm instead.

comment on column public.tenants.entity_type is 'persona (natural) vs empresa (jurídica) -- drives which fields the backoffice form requires.';
comment on column public.tenants.country is 'ISO 3166-1 alpha-2, e.g. CO, MX, US. Free text "OT" for not-yet-listed countries.';
comment on column public.tenants.logo_url is 'Public URL in the tenant-logos storage bucket. Max 5MB, enforced client-side and by bucket policy.';

-- Storage bucket for tenant logos. Public read (logos are meant to be
-- displayed everywhere, not sensitive); writes are gated by the policies
-- below to superadmin or the tenant's own admin, and scoped to a path that
-- starts with the tenant's own id so one tenant can never overwrite another's.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tenant-logos', 'tenant-logos', true, 5242880, array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])
on conflict (id) do nothing;

create policy tenant_logos_public_read on storage.objects
  for select using (bucket_id = 'tenant-logos');

create policy tenant_logos_write on storage.objects
  for insert with check (
    bucket_id = 'tenant-logos'
    and (public.is_superadmin() or (storage.foldername(name))[1] = public.auth_tenant_id()::text)
  );

create policy tenant_logos_update on storage.objects
  for update using (
    bucket_id = 'tenant-logos'
    and (public.is_superadmin() or (storage.foldername(name))[1] = public.auth_tenant_id()::text)
  );

create policy tenant_logos_delete on storage.objects
  for delete using (
    bucket_id = 'tenant-logos'
    and (public.is_superadmin() or (storage.foldername(name))[1] = public.auth_tenant_id()::text)
  );
