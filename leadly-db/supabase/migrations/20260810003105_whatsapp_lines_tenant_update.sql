-- Bug report: picking a different agent for a line in the tenant-side
-- "Líneas y Agentes" screen (LinesAndAgentsSection.tsx, shared with the
-- backoffice) looked like it worked (optimistic UI update) but never
-- actually stuck -- reverted on reload. Root cause: whatsapp_lines only had
-- an UPDATE policy for is_superadmin(). assignAiAssistantToLine's own
-- `.update({ ai_assistant_id })` call from a tenant_admin session matched
-- zero rows under RLS -- no error thrown (an UPDATE matching 0 visible rows
-- isn't a Postgres error), so the request "succeeded" while writing
-- nothing. This is the same self-service capability ai_assistants already
-- got (2026-08-06, ai_assistants_decoupled_from_lines) -- whatsapp_lines'
-- own UPDATE policy was never extended to match when that self-service
-- agent-assignment UI was built. authenticated already has a full-column
-- UPDATE grant on this table (checked via information_schema) -- this is
-- purely an RLS gap, not a missing grant.
create policy whatsapp_lines_tenant_update on public.whatsapp_lines
  for update using (tenant_id = public.auth_active_tenant_id())
  with check (tenant_id = public.auth_active_tenant_id());
