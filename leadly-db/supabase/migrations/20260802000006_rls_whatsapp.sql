-- Row Level Security for whatsapp_lines, ai_assistants, whatsapp_conversations
-- and whatsapp_messages. Reference: CLAUDE.md seccion 4 (backoffice vs panel
-- del cliente).
--
-- whatsapp_lines: only superadmin creates/assigns/deletes a line (backoffice
-- onboarding step). Tenant users can only read their own line(s), never the
-- access_token_secret_id column contents directly (that requires the vault
-- service_role path from an Edge Function, RLS alone does not protect a
-- column's value, only row visibility).

alter table public.whatsapp_lines enable row level security;

create policy whatsapp_lines_select on public.whatsapp_lines
  for select using (tenant_id = public.auth_tenant_id() or public.is_superadmin());

create policy whatsapp_lines_superadmin_write on public.whatsapp_lines
  for insert with check (public.is_superadmin());

create policy whatsapp_lines_superadmin_update on public.whatsapp_lines
  for update using (public.is_superadmin()) with check (public.is_superadmin());

create policy whatsapp_lines_superadmin_delete on public.whatsapp_lines
  for delete using (public.is_superadmin());

revoke all on public.whatsapp_lines from anon;

-- ai_assistants has no tenant_id column (kept 1:1 with whatsapp_lines to avoid
-- a denormalized column that could drift); RLS matches through the parent
-- line, same pattern Bedly uses for reservation_guests -> reservations.

alter table public.ai_assistants enable row level security;

create policy ai_assistants_select on public.ai_assistants
  for select using (
    public.is_superadmin()
    or exists (
      select 1 from public.whatsapp_lines wl
      where wl.id = ai_assistants.whatsapp_line_id and wl.tenant_id = public.auth_tenant_id()
    )
  );

create policy ai_assistants_insert on public.ai_assistants
  for insert with check (public.is_superadmin());

-- update allowed for superadmin, or a tenant_admin/tenant_agent of the owning
-- tenant -- this is the "config de IA por línea" screen on both layouts.
create policy ai_assistants_update on public.ai_assistants
  for update using (
    public.is_superadmin()
    or exists (
      select 1 from public.whatsapp_lines wl
      where wl.id = ai_assistants.whatsapp_line_id and wl.tenant_id = public.auth_tenant_id()
    )
  )
  with check (
    public.is_superadmin()
    or exists (
      select 1 from public.whatsapp_lines wl
      where wl.id = ai_assistants.whatsapp_line_id and wl.tenant_id = public.auth_tenant_id()
    )
  );

create policy ai_assistants_delete on public.ai_assistants
  for delete using (public.is_superadmin());

revoke all on public.ai_assistants from anon;

-- whatsapp_conversations: tenant_id is a real column here (see hardening
-- trigger in the previous migration), so RLS can match it directly.

alter table public.whatsapp_conversations enable row level security;

create policy whatsapp_conversations_select on public.whatsapp_conversations
  for select using (tenant_id = public.auth_tenant_id() or public.is_superadmin());

-- Inserts/updates from the webhook and AI-respond Edge Functions run with the
-- service_role key, which bypasses RLS entirely -- these policies only cover
-- the authenticated (browser) path, i.e. toggling ia/humano mode from the UI.
create policy whatsapp_conversations_update on public.whatsapp_conversations
  for update using (tenant_id = public.auth_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_tenant_id() or public.is_superadmin());

revoke all on public.whatsapp_conversations from anon;

-- whatsapp_messages: append-only ledger. No update/delete policy is granted
-- to anon/authenticated, so once RLS is enabled those operations are denied
-- for every client role except service_role/postgres (which bypass RLS).

alter table public.whatsapp_messages enable row level security;

create policy whatsapp_messages_select on public.whatsapp_messages
  for select using (
    public.is_superadmin()
    or exists (
      select 1 from public.whatsapp_conversations c
      where c.id = whatsapp_messages.conversation_id and c.tenant_id = public.auth_tenant_id()
    )
  );

-- The only client-side insert path is a human agent replying manually
-- (direction=outbound, sender_type=agent, sender_profile_id=self). Inbound
-- messages and AI replies are always inserted by Edge Functions with
-- service_role, which bypass this policy entirely.
create policy whatsapp_messages_insert_agent_reply on public.whatsapp_messages
  for insert with check (
    sender_type = 'agent'
    and sender_profile_id = auth.uid()
    and direction = 'outbound'
    and (
      public.is_superadmin()
      or exists (
        select 1 from public.whatsapp_conversations c
        where c.id = whatsapp_messages.conversation_id and c.tenant_id = public.auth_tenant_id()
      )
    )
  );

revoke all on public.whatsapp_messages from anon;
