-- Cutover de Oportunidades + Tareas, parte 3. crm_pipelines/crm_pipeline_stages
-- (a diferencia de contacts/opportunities/tasks) no tienen soft-delete --
-- "eliminar" ahí es un DELETE real (ver PipelineSettingsDrawer.tsx). El
-- espejo de la migración anterior solo cubría insert/update; sin esto, borrar
-- un pipeline/etapa desde el frontend (ya apuntando a `pipelines`/
-- `pipeline_stages` después del cutover) dejaría la fila vieja huérfana en
-- crm_pipelines/crm_pipeline_stages -- Aurora seguiría viéndola aunque ya no
-- exista en la UI.

create or replace function public.mirror_pipeline_delete_to_new()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return old;
  end if;
  delete from public.pipelines where id = old.id;
  return old;
end;
$$;

create trigger trg_mirror_crm_pipelines_delete_to_pipelines
  after delete on public.crm_pipelines
  for each row execute function public.mirror_pipeline_delete_to_new();

create or replace function public.mirror_pipeline_delete_to_crm()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return old;
  end if;
  delete from public.crm_pipelines where id = old.id;
  return old;
end;
$$;

create trigger trg_mirror_pipelines_delete_to_crm_pipelines
  after delete on public.pipelines
  for each row execute function public.mirror_pipeline_delete_to_crm();

create or replace function public.mirror_pipeline_stage_delete_to_new()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return old;
  end if;
  delete from public.pipeline_stages where id = old.id;
  return old;
end;
$$;

create trigger trg_mirror_crm_pipeline_stages_delete_to_pipeline_stages
  after delete on public.crm_pipeline_stages
  for each row execute function public.mirror_pipeline_stage_delete_to_new();

create or replace function public.mirror_pipeline_stage_delete_to_crm()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return old;
  end if;
  delete from public.crm_pipeline_stages where id = old.id;
  return old;
end;
$$;

create trigger trg_mirror_pipeline_stages_delete_to_crm_pipeline_stages
  after delete on public.pipeline_stages
  for each row execute function public.mirror_pipeline_stage_delete_to_crm();
