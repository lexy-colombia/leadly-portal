-- Seguimientos gets retired as its own top-level entity (it overlapped too
-- much with notas/PQR -- decision made together with the user) and folded
-- into a per-PQR thread instead: crm_pqr_updates. No production data exists
-- yet for this MVP, so dropping crm_followups outright is safe.
drop table if exists public.crm_followups cascade;

-- Append-only log scoped to a single PQR (like crm_notes, but per-case
-- instead of per-contact) -- same RLS shape as crm_notes: select/insert
-- tenant-scoped, no update/delete policy.
create table public.crm_pqr_updates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  pqr_id uuid not null references public.crm_pqrs(id) on delete cascade,
  content text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_by_ai boolean not null default false,
  created_at timestamptz not null default now()
);

create index crm_pqr_updates_pqr_id_idx on public.crm_pqr_updates(pqr_id);

alter table public.crm_pqr_updates enable row level security;

create policy crm_pqr_updates_select on public.crm_pqr_updates
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy crm_pqr_updates_insert on public.crm_pqr_updates
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.crm_pqr_updates from anon;

-- Lets the UI (and the tenant reviewing history) tell apart what the AI
-- created autonomously via the new whatsapp-ai-tools function vs. what a
-- human agent entered by hand.
alter table public.crm_notes add column created_by_ai boolean not null default false;
alter table public.crm_pqrs add column created_by_ai boolean not null default false;
