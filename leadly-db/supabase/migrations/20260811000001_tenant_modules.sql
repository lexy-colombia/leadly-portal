-- Per-tenant module gating: which items of the tenant panel's nav a given
-- tenant can see/use. Superadmin request (2026-08-11): a bare bridge table,
-- no catalog table -- unlike ai_skills (which needs a prompt_fragment for the
-- LLM), a module has no other DB-side data, it's purely a nav/route key
-- already defined in leadly-app's TenantLayout.tsx/App.tsx. The check
-- constraint below is the only place the fixed key list is enforced at the
-- DB layer; the frontend's lib/modules.ts is the source of truth for
-- label/icon/route and must be kept in sync with this list.
--
-- Presence-based, same shape as ai_assistant_skills: a row = enabled, no row
-- = disabled. That means the "all modules off by default" behavior the
-- superadmin asked for (including for every tenant that already exists in
-- production) falls out for free -- no backfill insert needed, the table
-- simply starts empty. Superadmin turns modules on per tenant from the new
-- "Módulos" tab in ClienteDetalle.tsx from here on. No business identity of
-- its own, so "disabling" a module is a real DELETE, not a soft-delete (same
-- exception already applied to ai_assistant_skills/conversation_tag_assignments
-- -- see CLAUDE.md section 3, "borrado siempre es soft-delete").
create table public.tenant_enabled_modules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  module_key text not null check (module_key in (
    'dashboard', 'conversations', 'contacts', 'pipeline', 'products', 'sales',
    'tasks', 'calendar', 'campaigns', 'reports', 'automations', 'aiAgents',
    'billing', 'settings'
  )),
  enabled_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, module_key)
);

create index tenant_enabled_modules_tenant_idx on public.tenant_enabled_modules(tenant_id);

alter table public.tenant_enabled_modules enable row level security;

-- The tenant reads its own enabled modules (needed to build its nav and pass
-- the route guard); superadmin reads everyone's, to render the backoffice tab.
create policy tenant_enabled_modules_select on public.tenant_enabled_modules
  for select to authenticated using (
    public.is_superadmin() or tenant_id = public.auth_tenant_id()
  );

-- Toggling a module is a superadmin-only action, same as ai_assistant_skills
-- -- the tenant doesn't self-serve this.
create policy tenant_enabled_modules_superadmin_write on public.tenant_enabled_modules
  for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin());
