-- Vault-backed storage for payment credential secrets, same pattern as
-- set_whatsapp_line_access_token/get_whatsapp_line_access_token (see
-- 20260802000012_whatsapp_line_secret_vault.sql). A payment credential can
-- need more than one secret (Wompi: private_key + integrity_key), so unlike
-- the single-column whatsapp_lines.access_token_secret_id this is a side
-- table keyed by (credential_id, secret_name) -- lets each provider adapter
-- declare whatever secret names it needs without a schema change.
create table public.payment_credential_secrets (
  id uuid primary key default gen_random_uuid(),
  credential_id uuid not null references public.tenant_payment_credentials(id) on delete cascade,
  secret_name text not null,
  secret_id uuid not null,
  created_at timestamptz not null default now(),
  unique (credential_id, secret_name)
);

alter table public.payment_credential_secrets enable row level security;

-- No policies grant direct table access to anyone (not even superadmin) --
-- this table only ever holds a vault.secrets pointer, never the value, and
-- is only ever touched through the RPCs below (security definer). RLS is
-- enabled with zero policies as a hard backstop against any accidental
-- direct query exposing the secret_id mapping.
revoke all on public.payment_credential_secrets from anon, authenticated;

create or replace function public.set_payment_credential_secret(p_credential_id uuid, p_secret_name text, p_secret_value text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_existing_secret_id uuid;
begin
  if not public.is_superadmin() then
    raise exception 'Only superadmin can set payment credential secrets';
  end if;

  if btrim(coalesce(p_secret_value, '')) = '' then
    raise exception 'p_secret_value is required';
  end if;

  if btrim(coalesce(p_secret_name, '')) = '' then
    raise exception 'p_secret_name is required';
  end if;

  if not exists (select 1 from public.tenant_payment_credentials where id = p_credential_id) then
    raise exception 'tenant_payment_credential % does not exist', p_credential_id;
  end if;

  select secret_id into v_existing_secret_id
    from public.payment_credential_secrets
    where credential_id = p_credential_id and secret_name = p_secret_name;

  if v_existing_secret_id is not null then
    perform vault.update_secret(v_existing_secret_id, p_secret_value);
  else
    insert into public.payment_credential_secrets (credential_id, secret_name, secret_id)
    values (
      p_credential_id,
      p_secret_name,
      vault.create_secret(
        p_secret_value,
        'payment_credential_' || p_credential_id::text || '_' || p_secret_name,
        'Payment provider secret "' || p_secret_name || '" for tenant_payment_credentials.id=' || p_credential_id::text
      )
    );
  end if;
end;
$$;

revoke execute on function public.set_payment_credential_secret(uuid, text, text) from public, anon;
grant execute on function public.set_payment_credential_secret(uuid, text, text) to authenticated;

-- Read path is intentionally narrower than WhatsApp's: no browser client
-- (tenant or superadmin) ever needs the raw value back, only Edge Functions
-- calling with the service role key, so this never bypasses to a
-- tenant/superadmin ownership check the way get_whatsapp_line_access_token
-- does.
create or replace function public.get_payment_credential_secret(p_credential_id uuid, p_secret_name text)
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
    raise exception 'Not authorized to read payment credential secrets';
  end if;

  select secret_id into v_secret_id
    from public.payment_credential_secrets
    where credential_id = p_credential_id and secret_name = p_secret_name;

  if v_secret_id is null then
    return null;
  end if;

  select decrypted_secret into v_value from vault.decrypted_secrets where id = v_secret_id;
  return v_value;
end;
$$;

revoke execute on function public.get_payment_credential_secret(uuid, text) from public, anon;
grant execute on function public.get_payment_credential_secret(uuid, text) to authenticated;

-- Lets the backoffice show which secrets are configured ("private key: OK",
-- "integrity key: falta") without ever exposing the values.
create or replace function public.payment_credential_configured_secrets(p_credential_id uuid)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(secret_name order by secret_name), array[]::text[])
  from public.payment_credential_secrets
  where credential_id = p_credential_id
  and exists (
    select 1 from public.tenant_payment_credentials c
    where c.id = p_credential_id
    and (public.is_superadmin() or c.tenant_id = public.auth_active_tenant_id())
  );
$$;

revoke execute on function public.payment_credential_configured_secrets(uuid) from public, anon;
grant execute on function public.payment_credential_configured_secrets(uuid) to authenticated;
