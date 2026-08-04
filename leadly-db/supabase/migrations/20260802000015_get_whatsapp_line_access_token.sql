-- Server-side read path for the Meta access token stored in Vault
-- (set_whatsapp_line_access_token, 20260802000012, is write-only on purpose).
-- Needed by whatsapp-ai-respond / whatsapp-send-human (service_role, calling
-- the Graph API on behalf of any line) and by whatsapp-send-human's caller
-- context (a tenant_admin/agent replying manually needs their OWN line's
-- token, never another tenant's).
create or replace function public.get_whatsapp_line_access_token(p_line_id uuid)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
  v_tenant_id uuid;
  v_token text;
begin
  select access_token_secret_id, tenant_id into v_secret_id, v_tenant_id
  from public.whatsapp_lines where id = p_line_id;

  if v_secret_id is null then
    return null;
  end if;

  -- service_role (Edge Functions acting on the webhook's behalf, not a
  -- specific user) bypasses the tenant check entirely; every other caller
  -- must be that line's own tenant or a superadmin.
  if auth.role() <> 'service_role' and not (public.is_superadmin() or v_tenant_id = public.auth_tenant_id()) then
    raise exception 'Not authorized to read this access token';
  end if;

  select decrypted_secret into v_token from vault.decrypted_secrets where id = v_secret_id;
  return v_token;
end;
$$;

revoke execute on function public.get_whatsapp_line_access_token(uuid) from public, anon;
grant execute on function public.get_whatsapp_line_access_token(uuid) to authenticated;
