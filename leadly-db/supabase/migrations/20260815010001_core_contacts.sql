-- ERP: esquema paralelo sin prefijo "crm_", Fase 0 (modelado, sin cutover).
-- Ver CLAUDE.md "Migración de nomenclatura crm_* -> esquema ERP sin prefijo"
-- para el contexto completo. Regla dura de esta ronda: ninguna tabla crm_*
-- se toca (cero alter/drop sobre ellas), estas son tablas 100% nuevas y
-- vacías, autocontenidas (nunca referencian una crm_*), y todavía no las usa
-- ni el frontend ni ninguna Edge Function -- ese cutover es una decisión
-- explícita aparte, después de probar este modelo.
--
-- 1:1 con crm_contacts / crm_notes / crm_contact_addresses, ver esas tablas
-- para el historial de por qué cada columna existe (incluye hubspot_contact_id
-- de la integración de HubSpot, y los campos nit/industry/website/address/
-- city/notes/is_active que absorbió crm_contacts cuando se revirtió el
-- modelo B2B crm_accounts el 2026-08-08 -- ese modelo B2B no se revive acá).

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  full_name text not null,
  phone text not null,
  email text,
  company text,
  stage text not null default 'lead' check (stage in ('lead', 'contactado', 'negociacion', 'cliente', 'perdido')),
  tags text[] not null default '{}',
  assigned_to uuid references public.profiles(id) on delete set null,
  nit text,
  industry text,
  website text,
  address text,
  city text,
  notes text,
  is_active boolean not null default true,
  hubspot_contact_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

create index contacts_tenant_id_idx on public.contacts(tenant_id);

-- Mismo criterio que crm_contacts: único por tenant+telefono solo entre
-- filas vivas, para poder recrear un contacto en ese teléfono si el
-- original quedó soft-deleted.
create unique index contacts_tenant_id_phone_active_idx on public.contacts(tenant_id, phone)
  where deleted_at is null;

create trigger contacts_set_updated_at
  before update on public.contacts
  for each row execute function public.set_updated_at();

alter table public.contacts enable row level security;

create policy contacts_select on public.contacts
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy contacts_insert on public.contacts
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy contacts_update on public.contacts
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy contacts_delete on public.contacts
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.contacts from anon;

-- Bitácora manual, append-only -- mismo patrón que crm_notes (sin
-- update/delete policy, RLS deniega por defecto lo que no tiene policy).
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  content text not null,
  created_by_ai boolean not null default false,
  created_at timestamptz not null default now()
);

create index notes_contact_id_idx on public.notes(contact_id);

alter table public.notes enable row level security;

create policy notes_select on public.notes
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy notes_insert on public.notes
  for insert with check (
    (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
    and (author_id = auth.uid() or author_id is null)
  );

revoke all on public.notes from anon;

-- Libreta de direcciones por contacto, reutilizable entre ventas.
create table public.contact_addresses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  label text,
  is_shipping boolean not null default true,
  is_billing boolean not null default false,
  recipient_name text,
  phone text,
  tax_id text,
  line1 text not null,
  line2 text,
  city text,
  state_province text,
  postal_code text,
  country text default 'Colombia',
  notes text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

create index contact_addresses_tenant_id_idx on public.contact_addresses(tenant_id);
create index contact_addresses_contact_id_idx on public.contact_addresses(contact_id);

create trigger contact_addresses_set_updated_at
  before update on public.contact_addresses
  for each row execute function public.set_updated_at();

alter table public.contact_addresses enable row level security;

create policy contact_addresses_select on public.contact_addresses
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy contact_addresses_insert on public.contact_addresses
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy contact_addresses_update on public.contact_addresses
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy contact_addresses_delete on public.contact_addresses
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.contact_addresses from anon;
