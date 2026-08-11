-- Lets a tenant_admin disconnect a WhatsApp line they connected themselves
-- (or a superadmin, any line) -- there was previously no way to remove a
-- line at all once created, only a superadmin-only status toggle. Refuses to
-- delete a line that already has conversations (whatsapp_conversations.
-- whatsapp_line_id is `on delete restrict`, see 20260802000005_whatsapp_core.sql)
-- so real message history can never be silently lost -- the caller gets a
-- clear error instead of a raw FK-violation. Also cleans up the Vault secret
-- so no orphaned access token is left behind. Does NOT call Meta's Graph API
-- to unsubscribe the webhook (Postgres has no outbound HTTP here) -- that's
-- an accepted, low-risk gap: the WABA keeps Leadly subscribed on Meta's side
-- until the tenant reconnects or removes access from their own Business
-- Manager, but no messages route anywhere once the line row is gone.
create or replace function public.delete_whatsapp_line(p_line_id uuid)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_tenant_id uuid;
  v_secret_id uuid;
begin
  select tenant_id, access_token_secret_id into v_tenant_id, v_secret_id
  from public.whatsapp_lines where id = p_line_id;

  if v_tenant_id is null then
    raise exception 'whatsapp_line % does not exist', p_line_id;
  end if;

  if not (
    public.is_superadmin()
    or (v_tenant_id = public.auth_tenant_id() and public.auth_role() = 'tenant_admin')
  ) then
    raise exception 'Not authorized to delete this WhatsApp line';
  end if;

  if exists (select 1 from public.whatsapp_conversations where whatsapp_line_id = p_line_id) then
    raise exception 'No se puede eliminar una línea que ya tiene conversaciones -- se perdería el historial.';
  end if;

  delete from public.whatsapp_lines where id = p_line_id;

  if v_secret_id is not null then
    delete from vault.secrets where id = v_secret_id;
  end if;
end;
$$;

revoke execute on function public.delete_whatsapp_line(uuid) from public, anon;
grant execute on function public.delete_whatsapp_line(uuid) to authenticated;
