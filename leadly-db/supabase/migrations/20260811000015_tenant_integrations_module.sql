-- Extends the Integraciones module (20260811000013/14) to be self-serve:
-- each tenant gets its own "Integraciones" screen (LaFactura/Wompi/Shopify/
-- HubSpot) to configure their *own* accounts with these providers, separate
-- from the backoffice's screen (Leadly's own accounts). Same tables
-- (integration_credentials, tenant_payment_credentials), scoped by the
-- tenant_id column that was already nullable for exactly this reason -- see
-- those tables' original comments ("para poder usarlo también con mis
-- clientes" / "schema-ready, not consumed by any UI/Edge Function yet").
--
-- 1) Registers 'integrations' as a togglable tenant module, same
--    presence-based pattern as the other 14 (20260811000001) -- starts
--    disabled for every tenant, superadmin turns it on per tenant from the
--    "Módulos" tab.
alter table public.tenant_enabled_modules drop constraint tenant_enabled_modules_module_key_check;
alter table public.tenant_enabled_modules add constraint tenant_enabled_modules_module_key_check check (module_key in (
  'dashboard', 'conversations', 'contacts', 'pipeline', 'products', 'sales',
  'tasks', 'calendar', 'campaigns', 'reports', 'automations', 'aiAgents',
  'billing', 'integrations', 'settings'
));

-- 2) A tenant_admin can now manage their own tenant's integration_credentials
--    row (insert/update/soft-delete), on top of superadmin's existing
--    all-access policy. A null tenant_id (the platform-level credential)
--    never matches auth_active_tenant_id(), so this can't be used to touch
--    Leadly's own credentials.
create policy integration_credentials_tenant_admin_write on public.integration_credentials
  for all to authenticated
  using (public.is_tenant_admin() and tenant_id = public.auth_active_tenant_id())
  with check (public.is_tenant_admin() and tenant_id = public.auth_active_tenant_id());

-- 3) Same for tenant_payment_credentials (Wompi) -- this table's own comment
--    already anticipated this ("para cuando un tenant facture a sus propios
--    clientes finales, schema-ready, not consumed by any UI yet"); this is
--    that UI.
create policy tenant_payment_credentials_tenant_admin_write on public.tenant_payment_credentials
  for all to authenticated
  using (public.is_tenant_admin() and tenant_id = public.auth_active_tenant_id())
  with check (public.is_tenant_admin() and tenant_id = public.auth_active_tenant_id());

-- 4) Relax set_integration_credential_secret: a tenant_admin can now set
--    secrets on their own tenant's credential row; the platform-level
--    credential (tenant_id null) still requires superadmin, same as before.
create or replace function public.set_integration_credential_secret(p_credential_id uuid, p_secret_name text, p_secret_value text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_existing_secret_id uuid;
  v_credential_tenant_id uuid;
  v_found boolean;
begin
  select true, tenant_id into v_found, v_credential_tenant_id
    from public.integration_credentials where id = p_credential_id;

  if not v_found then
    raise exception 'integration_credential % does not exist', p_credential_id;
  end if;

  if v_credential_tenant_id is null then
    if not public.is_superadmin() then
      raise exception 'Only superadmin can set the platform integration credential secrets';
    end if;
  elsif not (public.is_superadmin() or (public.is_tenant_admin() and v_credential_tenant_id = public.auth_active_tenant_id())) then
    raise exception 'Not authorized to set this integration credential secret';
  end if;

  if btrim(coalesce(p_secret_value, '')) = '' then
    raise exception 'p_secret_value is required';
  end if;

  if btrim(coalesce(p_secret_name, '')) = '' then
    raise exception 'p_secret_name is required';
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

-- 5) Same relaxation for set_payment_credential_secret (Wompi).
create or replace function public.set_payment_credential_secret(p_credential_id uuid, p_secret_name text, p_secret_value text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_existing_secret_id uuid;
  v_credential_tenant_id uuid;
  v_found boolean;
begin
  select true, tenant_id into v_found, v_credential_tenant_id
    from public.tenant_payment_credentials where id = p_credential_id;

  if not v_found then
    raise exception 'tenant_payment_credential % does not exist', p_credential_id;
  end if;

  if v_credential_tenant_id is null then
    if not public.is_superadmin() then
      raise exception 'Only superadmin can set the platform payment credential secrets';
    end if;
  elsif not (public.is_superadmin() or (public.is_tenant_admin() and v_credential_tenant_id = public.auth_active_tenant_id())) then
    raise exception 'Not authorized to set this payment credential secret';
  end if;

  if btrim(coalesce(p_secret_value, '')) = '' then
    raise exception 'p_secret_value is required';
  end if;

  if btrim(coalesce(p_secret_name, '')) = '' then
    raise exception 'p_secret_name is required';
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
