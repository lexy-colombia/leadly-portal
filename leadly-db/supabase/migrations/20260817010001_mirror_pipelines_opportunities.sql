-- Cutover de Oportunidades + Tareas (ver CLAUDE.md, ronda 2026-08-17). Mismo
-- mecanismo que el espejo crm_contacts <-> contacts: Aurora (whatsapp-ai-tools,
-- skill "oportunidades") sigue leyendo/escribiendo crm_pipelines/
-- crm_pipeline_stages/crm_opportunities exactamente igual que hoy -- no se
-- toca esa Edge Function. El frontend (Oportunidades.tsx y compañía) migra
-- a pipelines/pipeline_stages/opportunities (ya modeladas desde la Fase 3,
-- vacías, 1:1 columna a columna) en el mismo momento que esta migración.
--
-- Orden: pipelines primero, pipeline_stages después (FK a pipelines),
-- opportunities al final (FK a pipelines/pipeline_stages/contacts).
--
-- opportunity_stage_history NO se espeja de ida y vuelta -- es un log
-- append-only derivado. opportunities ya tiene sus propios triggers
-- (opportunities_log_initial_stage/opportunities_log_stage_change, ver
-- 20260815010003_core_pipeline.sql) que insertan ahí solos en cuanto el
-- espejo de abajo inserta/actualiza una fila en `opportunities` -- no hace
-- falta ningún trigger nuevo para eso, sale gratis.

create or replace function public.mirror_pipeline_to_new()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  insert into public.pipelines (id, tenant_id, name, description, color, is_active, created_at)
  values (new.id, new.tenant_id, new.name, new.description, new.color, new.is_active, new.created_at)
  on conflict (id) do update set
    name = excluded.name,
    description = excluded.description,
    color = excluded.color,
    is_active = excluded.is_active;

  return new;
end;
$$;

create trigger trg_mirror_crm_pipelines_to_pipelines
  after insert or update on public.crm_pipelines
  for each row execute function public.mirror_pipeline_to_new();

create or replace function public.mirror_pipeline_to_crm()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  insert into public.crm_pipelines (id, tenant_id, name, description, color, is_active, created_at)
  values (new.id, new.tenant_id, new.name, new.description, new.color, new.is_active, new.created_at)
  on conflict (id) do update set
    name = excluded.name,
    description = excluded.description,
    color = excluded.color,
    is_active = excluded.is_active;

  return new;
end;
$$;

create trigger trg_mirror_pipelines_to_crm_pipelines
  after insert or update on public.pipelines
  for each row execute function public.mirror_pipeline_to_crm();

insert into public.pipelines (id, tenant_id, name, description, color, is_active, created_at)
select id, tenant_id, name, description, color, is_active, created_at from public.crm_pipelines
on conflict (id) do nothing;

-- pipeline_stages

create or replace function public.mirror_pipeline_stage_to_new()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  insert into public.pipeline_stages (id, pipeline_id, name, display_order, color, probability, is_won, is_lost, created_at)
  values (new.id, new.pipeline_id, new.name, new.display_order, new.color, new.probability, new.is_won, new.is_lost, new.created_at)
  on conflict (id) do update set
    pipeline_id = excluded.pipeline_id,
    name = excluded.name,
    display_order = excluded.display_order,
    color = excluded.color,
    probability = excluded.probability,
    is_won = excluded.is_won,
    is_lost = excluded.is_lost;

  return new;
end;
$$;

create trigger trg_mirror_crm_pipeline_stages_to_pipeline_stages
  after insert or update on public.crm_pipeline_stages
  for each row execute function public.mirror_pipeline_stage_to_new();

create or replace function public.mirror_pipeline_stage_to_crm()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  insert into public.crm_pipeline_stages (id, pipeline_id, name, display_order, color, probability, is_won, is_lost, created_at)
  values (new.id, new.pipeline_id, new.name, new.display_order, new.color, new.probability, new.is_won, new.is_lost, new.created_at)
  on conflict (id) do update set
    pipeline_id = excluded.pipeline_id,
    name = excluded.name,
    display_order = excluded.display_order,
    color = excluded.color,
    probability = excluded.probability,
    is_won = excluded.is_won,
    is_lost = excluded.is_lost;

  return new;
end;
$$;

create trigger trg_mirror_pipeline_stages_to_crm_pipeline_stages
  after insert or update on public.pipeline_stages
  for each row execute function public.mirror_pipeline_stage_to_crm();

insert into public.pipeline_stages (id, pipeline_id, name, display_order, color, probability, is_won, is_lost, created_at)
select id, pipeline_id, name, display_order, color, probability, is_won, is_lost, created_at from public.crm_pipeline_stages
on conflict (id) do nothing;

-- opportunities

create or replace function public.mirror_opportunity_to_new()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  insert into public.opportunities (
    id, tenant_id, pipeline_id, stage_id, contact_id, owner_id, title, value, currency,
    priority, source, expected_close_date, status, description, deleted_at, deleted_by, created_at
  )
  values (
    new.id, new.tenant_id, new.pipeline_id, new.stage_id, new.contact_id, new.owner_id, new.title, new.value, new.currency,
    new.priority, new.source, new.expected_close_date, new.status, new.description, new.deleted_at, new.deleted_by, new.created_at
  )
  on conflict (id) do update set
    pipeline_id = excluded.pipeline_id,
    stage_id = excluded.stage_id,
    contact_id = excluded.contact_id,
    owner_id = excluded.owner_id,
    title = excluded.title,
    value = excluded.value,
    currency = excluded.currency,
    priority = excluded.priority,
    source = excluded.source,
    expected_close_date = excluded.expected_close_date,
    status = excluded.status,
    description = excluded.description,
    deleted_at = excluded.deleted_at,
    deleted_by = excluded.deleted_by;

  return new;
end;
$$;

create trigger trg_mirror_crm_opportunities_to_opportunities
  after insert or update on public.crm_opportunities
  for each row execute function public.mirror_opportunity_to_new();

create or replace function public.mirror_opportunity_to_crm()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  insert into public.crm_opportunities (
    id, tenant_id, pipeline_id, stage_id, contact_id, owner_id, title, value, currency,
    priority, source, expected_close_date, status, description, deleted_at, deleted_by, created_at
  )
  values (
    new.id, new.tenant_id, new.pipeline_id, new.stage_id, new.contact_id, new.owner_id, new.title, new.value, new.currency,
    new.priority, new.source, new.expected_close_date, new.status, new.description, new.deleted_at, new.deleted_by, new.created_at
  )
  on conflict (id) do update set
    pipeline_id = excluded.pipeline_id,
    stage_id = excluded.stage_id,
    contact_id = excluded.contact_id,
    owner_id = excluded.owner_id,
    title = excluded.title,
    value = excluded.value,
    currency = excluded.currency,
    priority = excluded.priority,
    source = excluded.source,
    expected_close_date = excluded.expected_close_date,
    status = excluded.status,
    description = excluded.description,
    deleted_at = excluded.deleted_at,
    deleted_by = excluded.deleted_by;

  return new;
end;
$$;

create trigger trg_mirror_opportunities_to_crm_opportunities
  after insert or update on public.opportunities
  for each row execute function public.mirror_opportunity_to_crm();

insert into public.opportunities (
  id, tenant_id, pipeline_id, stage_id, contact_id, owner_id, title, value, currency,
  priority, source, expected_close_date, status, description, deleted_at, deleted_by, created_at
)
select
  id, tenant_id, pipeline_id, stage_id, contact_id, owner_id, title, value, currency,
  priority, source, expected_close_date, status, description, deleted_at, deleted_by, created_at
from public.crm_opportunities
on conflict (id) do nothing;
