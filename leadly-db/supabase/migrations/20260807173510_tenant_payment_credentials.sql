-- tenant_id null = a platform-level credential (Leadly is the merchant --
-- used to bill tenants, the first real consumer of this module). tenant_id
-- set = that tenant's own credential (for when a tenant bills its own end
-- customers -- schema-ready, not consumed by any UI/Edge Function yet).
-- Only superadmin ever writes here (loaded from the backoffice, same as
-- WhatsApp lines) -- a tenant never self-serves its own payment credentials.
create table public.tenant_payment_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  provider_key text not null references public.payment_providers(key) on delete restrict,
  mode text not null default 'sandbox' check (mode in ('sandbox', 'production')),
  config jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

-- Postgres treats every null as distinct, so a plain unique(tenant_id,
-- provider_key) would allow unlimited platform-level rows (tenant_id null)
-- for the same provider -- coalesce to a sentinel uuid to actually enforce
-- "one active credential per (tenant-or-platform, provider)".
create unique index tenant_payment_credentials_scope_provider_idx
  on public.tenant_payment_credentials (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), provider_key)
  where deleted_at is null;

create index tenant_payment_credentials_tenant_id_idx on public.tenant_payment_credentials(tenant_id);

create trigger tenant_payment_credentials_set_updated_at
  before update on public.tenant_payment_credentials
  for each row execute function public.set_updated_at();

alter table public.tenant_payment_credentials enable row level security;

-- Tenants can see whether *their own* credential row exists/is active (so a
-- future self-service "conectado/no conectado" screen has something to read)
-- but never write it.
create policy tenant_payment_credentials_select on public.tenant_payment_credentials
  for select to authenticated using (
    public.is_superadmin() or tenant_id = public.auth_active_tenant_id()
  );

create policy tenant_payment_credentials_superadmin_write on public.tenant_payment_credentials
  for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin());

revoke all on public.tenant_payment_credentials from anon;
