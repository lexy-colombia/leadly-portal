-- ERP: esquema paralelo sin prefijo "crm_", Fase 0 (modelado, sin cutover).
-- Ver 20260815010001_core_contacts.sql para el contexto completo.
--
-- 1:1 con crm_pipelines/crm_pipeline_stages/crm_opportunities/
-- crm_opportunity_stage_history, ya sin account_id (ese modelo B2B no
-- vuelve). Los nombres de función/trigger llevan sufijo _core porque los
-- nombres originales (seed_default_pipeline, log_opportunity_initial_stage,
-- log_opportunity_stage_change) ya están en uso por los triggers de las
-- tablas crm_* -- redefinirlos con create or replace los hubiera
-- sobrescrito y roto el flujo de ventas por WhatsApp en producción.

create table public.pipelines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  description text,
  color text not null default '#2FA9A5',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index pipelines_tenant_id_idx on public.pipelines(tenant_id);

create trigger pipelines_set_updated_at
  before update on public.pipelines
  for each row execute function public.set_updated_at();

alter table public.pipelines enable row level security;

create policy pipelines_select on public.pipelines
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy pipelines_insert on public.pipelines
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy pipelines_update on public.pipelines
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy pipelines_delete on public.pipelines
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.pipelines from anon;

create table public.pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  pipeline_id uuid not null references public.pipelines(id) on delete cascade,
  name text not null,
  display_order integer not null default 0,
  color text not null default '#94A3B8',
  probability integer not null default 0 check (probability between 0 and 100),
  is_won boolean not null default false,
  is_lost boolean not null default false,
  created_at timestamptz not null default now()
);

create index pipeline_stages_pipeline_id_idx on public.pipeline_stages(pipeline_id);

alter table public.pipeline_stages enable row level security;

create policy pipeline_stages_select on public.pipeline_stages
  for select using (exists (
    select 1 from public.pipelines p where p.id = pipeline_stages.pipeline_id
      and (p.tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  ));
create policy pipeline_stages_insert on public.pipeline_stages
  for insert with check (exists (
    select 1 from public.pipelines p where p.id = pipeline_stages.pipeline_id
      and (p.tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  ));
create policy pipeline_stages_update on public.pipeline_stages
  for update using (exists (
    select 1 from public.pipelines p where p.id = pipeline_stages.pipeline_id
      and (p.tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  )) with check (exists (
    select 1 from public.pipelines p where p.id = pipeline_stages.pipeline_id
      and (p.tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  ));
create policy pipeline_stages_delete on public.pipeline_stages
  for delete using (exists (
    select 1 from public.pipelines p where p.id = pipeline_stages.pipeline_id
      and (p.tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  ));

revoke all on public.pipeline_stages from anon;

create table public.opportunities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  pipeline_id uuid not null references public.pipelines(id) on delete restrict,
  stage_id uuid not null references public.pipeline_stages(id) on delete restrict,
  contact_id uuid not null references public.contacts(id) on delete cascade,
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

create index opportunities_tenant_id_idx on public.opportunities(tenant_id);
create index opportunities_contact_id_idx on public.opportunities(contact_id);
create index opportunities_stage_id_idx on public.opportunities(stage_id);

create trigger opportunities_set_updated_at
  before update on public.opportunities
  for each row execute function public.set_updated_at();

alter table public.opportunities enable row level security;

create policy opportunities_select on public.opportunities
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy opportunities_insert on public.opportunities
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy opportunities_update on public.opportunities
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy opportunities_delete on public.opportunities
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.opportunities from anon;

create table public.opportunity_stage_history (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  from_stage_id uuid references public.pipeline_stages(id) on delete set null,
  to_stage_id uuid not null references public.pipeline_stages(id) on delete restrict,
  changed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index opportunity_stage_history_opportunity_id_idx on public.opportunity_stage_history(opportunity_id);
create index opportunity_stage_history_to_stage_id_idx on public.opportunity_stage_history(to_stage_id);

alter table public.opportunity_stage_history enable row level security;

create policy opportunity_stage_history_select on public.opportunity_stage_history
  for select using (exists (
    select 1 from public.opportunities o where o.id = opportunity_stage_history.opportunity_id
      and (o.tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  ));

revoke insert, update, delete on public.opportunity_stage_history from authenticated;
revoke all on public.opportunity_stage_history from anon;

create or replace function public.log_opportunity_initial_stage_core()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.opportunity_stage_history (opportunity_id, from_stage_id, to_stage_id, changed_by)
  values (new.id, null, new.stage_id, auth.uid());
  return new;
end;
$$;

create trigger opportunities_log_initial_stage
  after insert on public.opportunities
  for each row execute function public.log_opportunity_initial_stage_core();

create or replace function public.log_opportunity_stage_change_core()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.stage_id is distinct from old.stage_id then
    insert into public.opportunity_stage_history (opportunity_id, from_stage_id, to_stage_id, changed_by)
    values (new.id, old.stage_id, new.stage_id, auth.uid());
  end if;
  return new;
end;
$$;

create trigger opportunities_log_stage_change
  after update on public.opportunities
  for each row execute function public.log_opportunity_stage_change_core();

-- Mismos 6 stages/colores/probabilidades que seed_default_pipeline() usa
-- hoy para crm_pipelines -- este trigger corre en paralelo al viejo (ambos
-- disparan "after insert on tenants"), así todo tenant nuevo arranca con
-- pipeline poblado en las dos tablas mientras dure la transición.
create or replace function public.seed_default_pipeline_core()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pipeline_id uuid;
begin
  insert into public.pipelines (tenant_id, name) values (new.id, 'Ventas')
    returning id into v_pipeline_id;

  insert into public.pipeline_stages (pipeline_id, name, display_order, color, probability, is_won, is_lost) values
    (v_pipeline_id, 'Nuevo', 0, '#8B5CF6', 10, false, false),
    (v_pipeline_id, 'Contactado', 1, '#3B82F6', 25, false, false),
    (v_pipeline_id, 'Propuesta', 2, '#F59E0B', 50, false, false),
    (v_pipeline_id, 'Negociación', 3, '#F97316', 75, false, false),
    (v_pipeline_id, 'Ganado', 4, '#22C55E', 100, true, false),
    (v_pipeline_id, 'Perdido', 5, '#EF4444', 0, false, true);

  return new;
end;
$$;

create trigger tenants_seed_default_pipeline_core
  after insert on public.tenants
  for each row execute function public.seed_default_pipeline_core();
