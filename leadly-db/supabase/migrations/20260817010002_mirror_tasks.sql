-- Cutover de Oportunidades + Tareas, parte 2. Mismo patrón de espejo
-- bidireccional que crm_contacts<->contacts y crm_opportunities<->opportunities
-- -- Aurora (whatsapp-ai-tools, tool flag_interest_for_followup) sigue
-- escribiendo crm_tasks exactamente igual que hoy, sin tocar esa Edge
-- Function. crm_attachments.task_id sigue apuntando a crm_tasks (sin
-- cambios) -- válido porque el `id` es el mismo entre crm_tasks/tasks.

create or replace function public.mirror_task_to_new()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  insert into public.tasks (
    id, tenant_id, contact_id, opportunity_id, assigned_to, title, description,
    priority, status, due_date, deleted_at, deleted_by, created_at
  )
  values (
    new.id, new.tenant_id, new.contact_id, new.opportunity_id, new.assigned_to, new.title, new.description,
    new.priority, new.status, new.due_date, new.deleted_at, new.deleted_by, new.created_at
  )
  on conflict (id) do update set
    contact_id = excluded.contact_id,
    opportunity_id = excluded.opportunity_id,
    assigned_to = excluded.assigned_to,
    title = excluded.title,
    description = excluded.description,
    priority = excluded.priority,
    status = excluded.status,
    due_date = excluded.due_date,
    deleted_at = excluded.deleted_at,
    deleted_by = excluded.deleted_by;

  return new;
end;
$$;

create trigger trg_mirror_crm_tasks_to_tasks
  after insert or update on public.crm_tasks
  for each row execute function public.mirror_task_to_new();

create or replace function public.mirror_task_to_crm()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  insert into public.crm_tasks (
    id, tenant_id, contact_id, opportunity_id, assigned_to, title, description,
    priority, status, due_date, deleted_at, deleted_by, created_at
  )
  values (
    new.id, new.tenant_id, new.contact_id, new.opportunity_id, new.assigned_to, new.title, new.description,
    new.priority, new.status, new.due_date, new.deleted_at, new.deleted_by, new.created_at
  )
  on conflict (id) do update set
    contact_id = excluded.contact_id,
    opportunity_id = excluded.opportunity_id,
    assigned_to = excluded.assigned_to,
    title = excluded.title,
    description = excluded.description,
    priority = excluded.priority,
    status = excluded.status,
    due_date = excluded.due_date,
    deleted_at = excluded.deleted_at,
    deleted_by = excluded.deleted_by;

  return new;
end;
$$;

create trigger trg_mirror_tasks_to_crm_tasks
  after insert or update on public.tasks
  for each row execute function public.mirror_task_to_crm();

insert into public.tasks (
  id, tenant_id, contact_id, opportunity_id, assigned_to, title, description,
  priority, status, due_date, deleted_at, deleted_by, created_at
)
select
  id, tenant_id, contact_id, opportunity_id, assigned_to, title, description,
  priority, status, due_date, deleted_at, deleted_by, created_at
from public.crm_tasks
on conflict (id) do nothing;
