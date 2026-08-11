-- Lets a tenant configure its own logo from the tenant panel (Configuración),
-- not just the superadmin from the backoffice. The only existing UPDATE
-- policy on public.tenants is tenants_superadmin_update (20260802000003), so
-- a tenant_admin's own update would otherwise fail RLS. Rather than opening a
-- broad tenant-scoped UPDATE policy on the whole row (which would also let a
-- tenant_admin flip e.g. its own `status`), expose a narrow SECURITY DEFINER
-- RPC that only ever touches logo_url -- same write-only-surface pattern as
-- set_whatsapp_line_access_token (20260802000012).
create or replace function public.set_tenant_logo(p_tenant_id uuid, p_logo_url text)
returns public.tenants
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant public.tenants;
begin
  if not (public.is_superadmin() or (public.is_tenant_admin() and public.auth_tenant_id() = p_tenant_id)) then
    raise exception 'Not authorized to update this tenant''s logo';
  end if;

  update public.tenants set logo_url = p_logo_url where id = p_tenant_id
    returning * into v_tenant;

  if v_tenant is null then
    raise exception 'tenant % does not exist', p_tenant_id;
  end if;

  return v_tenant;
end;
$$;

revoke execute on function public.set_tenant_logo(uuid, text) from public, anon;
grant execute on function public.set_tenant_logo(uuid, text) to authenticated;
