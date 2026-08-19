-- Generic third-party integrations module, requested explicitly by the user
-- to hold things like LaFactura.co (Colombian DIAN e-invoicing, the provider
-- the sibling `lexy` project already uses) plus whatever else comes up later
-- ("otras plataformas"). Deliberately separate from payment_providers/
-- tenant_payment_credentials: those are coupled to the checkout/webhook
-- shape of a *payment* provider (PaymentProviderAdapter -- checkoutUrlFor,
-- createCheckout, verifyWebhookSignature...), which doesn't fit an
-- invoicing API like LaFactura (submit an invoice, get back a CUFE/XML, no
-- checkout or transaction involved). Wompi keeps living in its own working
-- system untouched; this catalog is for everything else.
--
-- Same tenant_id-nullable scoping as tenant_payment_credentials on purpose
-- ("debe ser genérico para poder usarlo también con mis clientes"): a null
-- tenant_id is Leadly's own platform-level credential (e.g. the LaFactura
-- account Leadly uses to invoice its tenants); a set tenant_id is that
-- tenant's own credential for their own use of the same provider.
create table public.integration_providers (
  key text primary key,
  name text not null,
  category text not null check (category in ('invoicing', 'accounting', 'messaging', 'other')),
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger integration_providers_set_updated_at
  before update on public.integration_providers
  for each row execute function public.set_updated_at();

alter table public.integration_providers enable row level security;

create policy integration_providers_select on public.integration_providers
  for select to authenticated using (true);

create policy integration_providers_superadmin_write on public.integration_providers
  for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin());

revoke all on public.integration_providers from anon;

-- Mapped now, not wired: no Edge Function calls LaFactura's API yet (no
-- account/credentials for Leadly's own use exist). This row exists so the
-- credential-storage/config UI has something real to configure once that
-- integration is actually built.
insert into public.integration_providers (key, name, category, description) values
  ('lafactura', 'LaFactura.co', 'invoicing', 'Facturación electrónica DIAN (Colombia). Integración mapeada -- la emisión real (CUFE/XML) todavía no está conectada.');

create table public.integration_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  provider_key text not null references public.integration_providers(key) on delete restrict,
  mode text not null default 'sandbox' check (mode in ('sandbox', 'production')),
  config jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

create unique index integration_credentials_scope_provider_idx
  on public.integration_credentials (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), provider_key)
  where deleted_at is null;

create index integration_credentials_tenant_id_idx on public.integration_credentials(tenant_id);

create trigger integration_credentials_set_updated_at
  before update on public.integration_credentials
  for each row execute function public.set_updated_at();

alter table public.integration_credentials enable row level security;

create policy integration_credentials_select on public.integration_credentials
  for select to authenticated using (
    public.is_superadmin() or tenant_id = public.auth_active_tenant_id()
  );

create policy integration_credentials_superadmin_write on public.integration_credentials
  for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin());

revoke all on public.integration_credentials from anon;

-- Secret storage: exact mirror of payment_credential_secrets
-- (20260807173529) -- a side table keyed by (credential_id, secret_name) so
-- any provider can declare whatever secret names it needs (LaFactura's API
-- key, a future provider's client secret, etc.) without a schema change,
-- Vault-backed, never exposes the raw value outside service_role.
create table public.integration_credential_secrets (
  id uuid primary key default gen_random_uuid(),
  credential_id uuid not null references public.integration_credentials(id) on delete cascade,
  secret_name text not null,
  secret_id uuid not null,
  created_at timestamptz not null default now(),
  unique (credential_id, secret_name)
);

alter table public.integration_credential_secrets enable row level security;
revoke all on public.integration_credential_secrets from anon, authenticated;

create or replace function public.set_integration_credential_secret(p_credential_id uuid, p_secret_name text, p_secret_value text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_existing_secret_id uuid;
begin
  if not public.is_superadmin() then
    raise exception 'Only superadmin can set integration credential secrets';
  end if;

  if btrim(coalesce(p_secret_value, '')) = '' then
    raise exception 'p_secret_value is required';
  end if;

  if btrim(coalesce(p_secret_name, '')) = '' then
    raise exception 'p_secret_name is required';
  end if;

  if not exists (select 1 from public.integration_credentials where id = p_credential_id) then
    raise exception 'integration_credential % does not exist', p_credential_id;
  end if;

  select secret_id into v_existing_secret_id
    from public.integration_credential_secrets
    where credential_id = p_credential_id and secret_name = p_secret_name;

  if v_existing_secret_id is not null then
    perform vault.update_secret(v_existing_secret_id, p_secret_value);
  else
    insert into public.integration_credential_secrets (credential_id, secret_name, secret_id)
    values (
      p_credential_id,
      p_secret_name,
      vault.create_secret(
        p_secret_value,
        'integration_credential_' || p_credential_id::text || '_' || p_secret_name,
        'Integration secret "' || p_secret_name || '" for integration_credentials.id=' || p_credential_id::text
      )
    );
  end if;
end;
$$;

revoke execute on function public.set_integration_credential_secret(uuid, text, text) from public, anon;
grant execute on function public.set_integration_credential_secret(uuid, text, text) to authenticated;

create or replace function public.get_integration_credential_secret(p_credential_id uuid, p_secret_name text)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
  v_value text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Not authorized to read integration credential secrets';
  end if;

  select secret_id into v_secret_id
    from public.integration_credential_secrets
    where credential_id = p_credential_id and secret_name = p_secret_name;

  if v_secret_id is null then
    return null;
  end if;

  select decrypted_secret into v_value from vault.decrypted_secrets where id = v_secret_id;
  return v_value;
end;
$$;

revoke execute on function public.get_integration_credential_secret(uuid, text) from public, anon;
grant execute on function public.get_integration_credential_secret(uuid, text) to authenticated;

create or replace function public.integration_credential_configured_secrets(p_credential_id uuid)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(secret_name order by secret_name), array[]::text[])
  from public.integration_credential_secrets
  where credential_id = p_credential_id
  and exists (
    select 1 from public.integration_credentials c
    where c.id = p_credential_id
    and (public.is_superadmin() or c.tenant_id = public.auth_active_tenant_id())
  );
$$;

revoke execute on function public.integration_credential_configured_secrets(uuid) from public, anon;
grant execute on function public.integration_credential_configured_secrets(uuid) to authenticated;
