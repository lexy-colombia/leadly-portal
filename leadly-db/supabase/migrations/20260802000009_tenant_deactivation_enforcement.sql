-- Makes tenants.status = 'inactive' actually block access, instead of being a
-- cosmetic flag. Backoffice "Clientes" module (CLAUDE.md sección 4.1) exposes
-- an activar/desactivar control; without this, RLS never looked at status at
-- all -- a deactivated tenant's users could keep reading/writing everything.
--
-- Design: keep auth_tenant_id() unconditional (a tenant's own users must
-- still be able to see their own tenants/profiles rows even while inactive,
-- so the app can show a clear "tu empresa está desactivada" screen instead
-- of opaque RLS-empty-result silence). Add a second helper,
-- auth_active_tenant_id(), that returns NULL when the tenant is inactive,
-- and swap it into the RLS policies for OPERATIONAL data only (WhatsApp
-- lines, AI config, conversations, messages) -- those go dark immediately on
-- deactivation, while tenants/profiles visibility is unaffected.
create or replace function public.auth_active_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.tenant_id
  from public.profiles p
  join public.tenants t on t.id = p.tenant_id
  where p.id = auth.uid() and t.status = 'active';
$$;

revoke execute on function public.auth_active_tenant_id() from public;
grant execute on function public.auth_active_tenant_id() to authenticated;

-- whatsapp_lines
drop policy whatsapp_lines_select on public.whatsapp_lines;
create policy whatsapp_lines_select on public.whatsapp_lines
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

-- ai_assistants (matched through parent line, same as before)
drop policy ai_assistants_select on public.ai_assistants;
create policy ai_assistants_select on public.ai_assistants
  for select using (
    public.is_superadmin()
    or exists (
      select 1 from public.whatsapp_lines wl
      where wl.id = ai_assistants.whatsapp_line_id and wl.tenant_id = public.auth_active_tenant_id()
    )
  );

drop policy ai_assistants_update on public.ai_assistants;
create policy ai_assistants_update on public.ai_assistants
  for update using (
    public.is_superadmin()
    or exists (
      select 1 from public.whatsapp_lines wl
      where wl.id = ai_assistants.whatsapp_line_id and wl.tenant_id = public.auth_active_tenant_id()
    )
  )
  with check (
    public.is_superadmin()
    or exists (
      select 1 from public.whatsapp_lines wl
      where wl.id = ai_assistants.whatsapp_line_id and wl.tenant_id = public.auth_active_tenant_id()
    )
  );

-- whatsapp_conversations
drop policy whatsapp_conversations_select on public.whatsapp_conversations;
create policy whatsapp_conversations_select on public.whatsapp_conversations
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

drop policy whatsapp_conversations_update on public.whatsapp_conversations;
create policy whatsapp_conversations_update on public.whatsapp_conversations
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

-- whatsapp_messages
drop policy whatsapp_messages_select on public.whatsapp_messages;
create policy whatsapp_messages_select on public.whatsapp_messages
  for select using (
    public.is_superadmin()
    or exists (
      select 1 from public.whatsapp_conversations c
      where c.id = whatsapp_messages.conversation_id and c.tenant_id = public.auth_active_tenant_id()
    )
  );

drop policy whatsapp_messages_insert_agent_reply on public.whatsapp_messages;
create policy whatsapp_messages_insert_agent_reply on public.whatsapp_messages
  for insert with check (
    sender_type = 'agent'
    and sender_profile_id = auth.uid()
    and direction = 'outbound'
    and (
      public.is_superadmin()
      or exists (
        select 1 from public.whatsapp_conversations c
        where c.id = whatsapp_messages.conversation_id and c.tenant_id = public.auth_active_tenant_id()
      )
    )
  );
