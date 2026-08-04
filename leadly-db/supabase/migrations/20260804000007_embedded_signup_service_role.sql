-- Lets the whatsapp-embedded-signup Edge Function (service_role) store a
-- client's own access token after they complete WhatsApp Embedded Signup
-- themselves -- previously this RPC was superadmin-only, which made sense
-- when only the backoffice ever set a token by hand. Self-service signup is
-- a new, separate write path: the Edge Function validates the caller is a
-- tenant_admin of that tenant *before* calling this (see function body),
-- then uses its own service_role connection to write the token, so RLS on
-- whatsapp_lines itself is untouched -- tenants still can't INSERT a line
-- directly from the browser, only through the vetted Edge Function.
create or replace function public.set_whatsapp_line_access_token(p_line_id uuid, p_access_token text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_existing_secret_id uuid;
begin
  if not (public.is_superadmin() or auth.role() = 'service_role') then
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
