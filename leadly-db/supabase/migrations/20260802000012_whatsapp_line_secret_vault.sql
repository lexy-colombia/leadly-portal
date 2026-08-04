-- Supabase Vault-backed storage for whatsapp_lines.access_token_secret_id
-- (see 20260802000005_whatsapp_core.sql comment). The frontend (authenticated
-- role) must never see the raw Meta access token: vault.decrypted_secrets is
-- only readable by privileged roles (postgres/service_role), so the only way
-- authenticated can touch a token is through this write-only RPC. Reading it
-- back (for the whatsapp-webhook / whatsapp-ai-respond Edge Functions to call
-- the Graph API) happens later, directly from those functions using
-- service_role, which bypasses this entirely -- no public read path is
-- exposed here on purpose.
create or replace function public.set_whatsapp_line_access_token(p_line_id uuid, p_access_token text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_existing_secret_id uuid;
begin
  if not public.is_superadmin() then
    raise exception 'Only superadmin can set WhatsApp access tokens';
  end if;

  if btrim(coalesce(p_access_token, '')) = '' then
    raise exception 'p_access_token is required';
  end if;

  if not exists (select 1 from public.whatsapp_lines where id = p_line_id) then
    raise exception 'whatsapp_line % does not exist', p_line_id;
  end if;

  select access_token_secret_id into v_existing_secret_id from public.whatsapp_lines where id = p_line_id;

  if v_existing_secret_id is not null then
    perform vault.update_secret(v_existing_secret_id, p_access_token);
  else
    update public.whatsapp_lines
      set access_token_secret_id = vault.create_secret(
        p_access_token,
        'whatsapp_line_' || p_line_id::text,
        'Meta WhatsApp Cloud API access token for whatsapp_lines.id=' || p_line_id::text
      )
      where id = p_line_id;
  end if;
end;
$$;

revoke execute on function public.set_whatsapp_line_access_token(uuid, text) from public, anon;
grant execute on function public.set_whatsapp_line_access_token(uuid, text) to authenticated;

-- Lets the backoffice show "token configurado" / "sin token" without ever
-- exposing the value itself.
create or replace function public.whatsapp_line_has_access_token(p_line_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select access_token_secret_id is not null
  from public.whatsapp_lines
  where id = p_line_id
  and (tenant_id = public.auth_tenant_id() or public.is_superadmin());
$$;

revoke execute on function public.whatsapp_line_has_access_token(uuid) from public, anon;
grant execute on function public.whatsapp_line_has_access_token(uuid) to authenticated;
