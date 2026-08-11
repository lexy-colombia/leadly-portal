-- Opportunities/pipeline: crm_contacts.stage was a single fixed enum at the
-- *contact* level (a contact can only ever be in one stage at a time, no
-- value, no close date, no probability). This adds a real deal-tracking
-- layer on top -- a contact can now have several opportunities over time
-- (or concurrently), each with its own stage/value/close date.
-- crm_contacts.stage is kept as-is: it's still useful as a lightweight
-- overall relationship classification independent of any single deal.
--
-- Pipeline configuration is deliberately simple for v1 (one pipeline per
-- tenant, fixed default stages) rather than a fully generic multi-pipeline
-- builder -- see CLAUDE.md for why. The tables support more than one
-- pipeline per tenant already (no unique constraint), so nothing blocks
-- adding that UI later without another migration.
create table public.crm_pipelines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  description text,
  color text not null default '#2FA9A5',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index crm_pipelines_tenant_id_idx on public.crm_pipelines(tenant_id);

create trigger crm_pipelines_set_updated_at
  before update on public.crm_pipelines
  for each row execute function public.set_updated_at();

create table public.crm_pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  pipeline_id uuid not null references public.crm_pipelines(id) on delete cascade,
  name text not null,
  display_order integer not null default 0,
  color text not null default '#94A3B8',
  probability integer not null default 0 check (probability between 0 and 100),
  is_won boolean not null default false,
  is_lost boolean not null default false,
  created_at timestamptz not null default now()
);

create index crm_pipeline_stages_pipeline_id_idx on public.crm_pipeline_stages(pipeline_id);

create table public.crm_opportunities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  pipeline_id uuid not null references public.crm_pipelines(id) on delete restrict,
  stage_id uuid not null references public.crm_pipeline_stages(id) on delete restrict,
  contact_id uuid not null references public.crm_contacts(id) on delete cascade,
  account_id uuid references public.crm_accounts(id) on delete set null,
  owner_id uuid references public.profiles(id) on delete set null,
  title text not null,
  value numeric(14, 2) not null default 0,
  currency text not null default 'COP',
  priority text not null default 'media' check (priority in ('baja', 'media', 'alta')),
  source text,
  expected_close_date date,
  status text not null default 'open' check (status in ('open', 'won', 'lost')),
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

create index crm_opportunities_tenant_id_idx on public.crm_opportunities(tenant_id);
create index crm_opportunities_contact_id_idx on public.crm_opportunities(contact_id);
create index crm_opportunities_stage_id_idx on public.crm_opportunities(stage_id);

create trigger crm_opportunities_set_updated_at
  before update on public.crm_opportunities
  for each row execute function public.set_updated_at();

alter table public.crm_pipelines enable row level security;
alter table public.crm_pipeline_stages enable row level security;
alter table public.crm_opportunities enable row level security;

create policy crm_pipelines_select on public.crm_pipelines
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_pipelines_write on public.crm_pipelines
  for all using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy crm_pipeline_stages_select on public.crm_pipeline_stages
  for select using (
    exists (select 1 from public.crm_pipelines p where p.id = crm_pipeline_stages.pipeline_id
      and (p.tenant_id = public.auth_active_tenant_id() or public.is_superadmin()))
  );
create policy crm_pipeline_stages_write on public.crm_pipeline_stages
  for all using (
    exists (select 1 from public.crm_pipelines p where p.id = crm_pipeline_stages.pipeline_id
      and (p.tenant_id = public.auth_active_tenant_id() or public.is_superadmin()))
  )
  with check (
    exists (select 1 from public.crm_pipelines p where p.id = crm_pipeline_stages.pipeline_id
      and (p.tenant_id = public.auth_active_tenant_id() or public.is_superadmin()))
  );

create policy crm_opportunities_select on public.crm_opportunities
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_opportunities_insert on public.crm_opportunities
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_opportunities_update on public.crm_opportunities
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_opportunities_delete on public.crm_opportunities
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.crm_pipelines from anon;
revoke all on public.crm_pipeline_stages from anon;
revoke all on public.crm_opportunities from anon;

-- Every tenant gets one default pipeline the moment it's created, same
-- pattern as a whatsapp_line always getting a default (inactive)
-- ai_assistant -- a tenant should never be able to reach "Oportunidades" and
-- find nowhere to put one. Fires for both onboarding paths (self_register_tenant
-- and the backoffice's createTenant) since it's a DB trigger, not app code.
create function public.seed_default_pipeline() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pipeline_id uuid;
begin
  insert into public.crm_pipelines (tenant_id, name) values (new.id, 'Ventas') returning id into v_pipeline_id;

  insert into public.crm_pipeline_stages (pipeline_id, name, display_order, probability, is_won, is_lost) values
    (v_pipeline_id, 'Nuevo', 0, 10, false, false),
    (v_pipeline_id, 'Contactado', 1, 25, false, false),
    (v_pipeline_id, 'Propuesta', 2, 50, false, false),
    (v_pipeline_id, 'Negociación', 3, 75, false, false),
    (v_pipeline_id, 'Ganado', 4, 100, true, false),
    (v_pipeline_id, 'Perdido', 5, 0, false, true);

  return new;
end;
$$;

create trigger tenants_seed_default_pipeline
  after insert on public.tenants
  for each row execute function public.seed_default_pipeline();

-- Backfill: tenants that already existed before this migration.
do $$
declare
  v_tenant record;
  v_pipeline_id uuid;
begin
  for v_tenant in select id from public.tenants where id not in (select tenant_id from public.crm_pipelines) loop
    insert into public.crm_pipelines (tenant_id, name) values (v_tenant.id, 'Ventas') returning id into v_pipeline_id;
    insert into public.crm_pipeline_stages (pipeline_id, name, display_order, probability, is_won, is_lost) values
      (v_pipeline_id, 'Nuevo', 0, 10, false, false),
      (v_pipeline_id, 'Contactado', 1, 25, false, false),
      (v_pipeline_id, 'Propuesta', 2, 50, false, false),
      (v_pipeline_id, 'Negociación', 3, 75, false, false),
      (v_pipeline_id, 'Ganado', 4, 100, true, false),
      (v_pipeline_id, 'Perdido', 5, 0, false, true);
  end loop;
end;
$$;
