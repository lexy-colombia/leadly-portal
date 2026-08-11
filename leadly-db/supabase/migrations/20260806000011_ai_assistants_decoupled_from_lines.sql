-- Decouples ai_assistants ("agentes de IA") from whatsapp_lines. Until now
-- `ai_assistants.whatsapp_line_id` was `not null unique` -- a hard 1:1, so a
-- tenant with 3 lines wanting "the same sales persona" on all of them had to
-- configure (and keep in sync by hand) 3 separate copies of the same prompt.
-- Requested by the user after using the product for a bit: "a una línea le
-- puedo asignar un agente, pero este mismo agente lo puedo configurar en
-- varias líneas" -- i.e. many-lines-to-one-agent (M:1), not the other way
-- around (a line only ever has one agent actively answering at a time).
--
-- The FK direction flips: instead of the assistant owning a pointer to its
-- one line, the line now owns a pointer to its currently assigned agent
-- (`whatsapp_lines.ai_assistant_id`, nullable -- a line can exist with no
-- agent assigned). `ai_assistant_skills` needed zero changes -- it was
-- already keyed by `ai_assistant_id` alone, correctly modeling skills as a
-- property of the agent/persona, never of the line.
--
-- Every existing assistant survives as-is: this migration only adds columns,
-- backfills them from the current 1:1 data, then drops the old column --
-- nothing is deleted, no existing prompt/model/skill config is touched.

alter table public.ai_assistants add column tenant_id uuid references public.tenants(id) on delete cascade;
alter table public.ai_assistants add column name text;

-- Backfill while whatsapp_line_id (the old 1:1 pointer) still exists, so we
-- can derive both the owning tenant and a sensible default name from it.
update public.ai_assistants a
set tenant_id = wl.tenant_id,
    name = 'Asistente de ' || wl.display_name
from public.whatsapp_lines wl
where a.whatsapp_line_id = wl.id;

alter table public.ai_assistants alter column tenant_id set not null;
alter table public.ai_assistants alter column name set not null;
alter table public.ai_assistants add constraint ai_assistants_name_not_blank check (btrim(name) <> '');

create index ai_assistants_tenant_id_idx on public.ai_assistants(tenant_id);

-- New FK direction: the line points at its currently assigned agent.
-- on delete restrict (not set null/cascade) on purpose -- deleting an agent
-- still assigned to one or more lines would silently turn AI auto-reply off
-- on those lines with no warning, which is exactly the kind of "invisible
-- footgun" this app avoids elsewhere (see e.g. delete_whatsapp_line
-- refusing to delete a line that already has conversations).
alter table public.whatsapp_lines add column ai_assistant_id uuid references public.ai_assistants(id) on delete restrict;

update public.whatsapp_lines wl
set ai_assistant_id = a.id
from public.ai_assistants a
where a.whatsapp_line_id = wl.id;

create index whatsapp_lines_ai_assistant_id_idx on public.whatsapp_lines(ai_assistant_id);

-- RLS policies referencing whatsapp_line_id must be dropped before the
-- column itself can be -- Postgres refuses to drop a column that a policy
-- still depends on. Also widens insert/delete from superadmin-only to the
-- owning tenant too (matching every other tenant-owned CRM table, e.g.
-- crm_accounts/crm_opportunities) -- a tenant can already fully edit an
-- agent's prompt/model/active state via the existing update policy, so
-- gating only row creation/deletion to superadmin no longer made sense once
-- agents are a tenant-managed catalog instead of an implicit side effect of
-- a superadmin-only "create line" flow.
drop policy ai_assistants_select on public.ai_assistants;
drop policy ai_assistants_insert on public.ai_assistants;
drop policy ai_assistants_update on public.ai_assistants;
drop policy ai_assistants_delete on public.ai_assistants;

-- Same reason -- this policy on the *other* table also reads
-- ai_assistants.whatsapp_line_id via a join, so it depends on the column too.
drop policy ai_assistant_skills_select on public.ai_assistant_skills;

-- Drop the old 1:1 pointer (and, implicitly, its unique constraint/FK) --
-- nothing else references this column now that the policies above are gone.
alter table public.ai_assistants drop column whatsapp_line_id;

comment on table public.ai_assistants is 'Reusable AI agent persona, scoped to a tenant (not to a single line). Assignable to zero or more whatsapp_lines via whatsapp_lines.ai_assistant_id.';

-- ai_assistants now has its own tenant_id, so the new policies match it
-- directly instead of joining through whatsapp_lines.
create policy ai_assistants_select on public.ai_assistants
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy ai_assistants_insert on public.ai_assistants
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy ai_assistants_update on public.ai_assistants
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy ai_assistants_delete on public.ai_assistants
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

-- ai_assistant_skills: same simplification, now that ai_assistants.tenant_id
-- exists directly instead of needing a join through whatsapp_lines. Also
-- swapped to auth_active_tenant_id() (a deactivated tenant loses visibility
-- into its own skills, consistent with every other operational table) --
-- the original policy predated auth_active_tenant_id() and was never
-- revisited when that helper was introduced.
create policy ai_assistant_skills_select on public.ai_assistant_skills
  for select to authenticated using (
    public.is_superadmin()
    or exists (
      select 1 from public.ai_assistants a
      where a.id = ai_assistant_skills.ai_assistant_id
      and a.tenant_id = public.auth_active_tenant_id()
    )
  );
