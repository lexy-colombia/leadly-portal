-- Lets a tenant_admin assign a conversation to a specific agent, so agents
-- can filter their Inbox down to "Mis" (mine) instead of seeing the whole
-- tenant's traffic. No RLS change needed: the existing
-- whatsapp_conversations_update policy already scopes updates to the
-- caller's own tenant, which covers setting this column too.
alter table public.whatsapp_conversations
  add column assigned_agent_id uuid references public.profiles(id) on delete set null;

create index whatsapp_conversations_assigned_agent_id_idx on public.whatsapp_conversations(assigned_agent_id);
