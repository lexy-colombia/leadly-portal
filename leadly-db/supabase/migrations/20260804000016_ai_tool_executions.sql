-- Audit log for every AI tool-calling execution (whatsapp-ai-tools) -- same
-- purpose as tania-functions' function_log_repository:
-- lets the tenant (later, via a UI) see exactly what the AI did on its own
-- and with what arguments/result. Only service_role ever writes here
-- (whatsapp-ai-tools uses the service role key, which bypasses RLS), so
-- there's no insert policy for `authenticated` -- read-only for tenants.
create table public.ai_tool_executions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid not null references public.whatsapp_conversations(id) on delete cascade,
  function_name text not null,
  parameters jsonb not null,
  result jsonb,
  error_message text,
  created_at timestamptz not null default now()
);

create index ai_tool_executions_conversation_id_idx on public.ai_tool_executions(conversation_id);

alter table public.ai_tool_executions enable row level security;

create policy ai_tool_executions_select on public.ai_tool_executions
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.ai_tool_executions from anon;
