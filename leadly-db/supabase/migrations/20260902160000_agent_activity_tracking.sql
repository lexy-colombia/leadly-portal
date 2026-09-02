-- Fase 1 de "Oportunidades/Tareas/Citas deben ser transversales" (pedido
-- explícito del usuario, 2026-09-02, a raíz del caso Pragma Consulting):
-- hasta ahora no existía ninguna forma de medir si un agente cumple sus
-- tareas ni de saber qué está vencido -- tasks no tenía completed_at (solo
-- updated_at, que cambia con cualquier edición, no sirve para medir "a
-- tiempo vs. tarde"), y appointments no tenía ningún campo de responsable
-- más allá de created_by (quien la agendó, no necesariamente quien debe
-- atenderla). Sin esto, ningún tablero de rendimiento futuro (Fase 4 de la
-- rondas) tendría datos reales de los que partir.

-- 1) tasks.completed_at/completed_by -- se llenan solos vía trigger cuando
-- status pasa a 'completada' (y se limpian si se reabre), nunca a mano
-- desde el frontend -- mismo criterio que opportunity_stage_history
-- (changed_by = auth.uid(), null para llamadas de service_role).
alter table public.tasks add column completed_at timestamptz;
alter table public.tasks add column completed_by uuid references public.profiles(id);

create or replace function public.set_task_completed_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'completada' and old.status is distinct from 'completada' then
    new.completed_at := now();
    new.completed_by := auth.uid();
  elsif new.status is distinct from 'completada' and old.status = 'completada' then
    new.completed_at := null;
    new.completed_by := null;
  end if;
  return new;
end;
$$;

create trigger tasks_set_completed_at
  before update on public.tasks
  for each row execute function public.set_task_completed_at();

revoke execute on function public.set_task_completed_at() from public;

-- 2) appointments.assigned_to -- por default el mismo que created_by (quien
-- la agendó atiende la cita, caso más común hoy), pero queda como columna
-- propia para poder reasignarla a futuro sin pisar el dato de auditoría de
-- quién la creó. Backfill de las citas existentes con el mismo criterio.
alter table public.appointments add column assigned_to uuid references public.profiles(id);

update public.appointments set assigned_to = created_by where assigned_to is null;

create or replace function public.default_appointment_assigned_to()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.assigned_to is null then
    new.assigned_to := new.created_by;
  end if;
  return new;
end;
$$;

create trigger appointments_default_assigned_to
  before insert on public.appointments
  for each row execute function public.default_appointment_assigned_to();

revoke execute on function public.default_appointment_assigned_to() from public;

-- 3) Resumen de actividad por agente (tareas + citas) -- sin tabla de
-- "reportes" propia (ya descartado en CLAUDE.md 3.6), consulta directa
-- igual que el resto de métricas del Dashboard. security invoker a
-- propósito, mismo criterio que transfer_stock (20260817220000): la RLS ya
-- existente de tasks_select/appointments_select/profiles_select acota todo
-- a auth_active_tenant_id() (o al propio superadmin) sola -- p_tenant_id es
-- solo comodidad de filtrado para el caller, nunca el límite de seguridad
-- real, así que no hace falta duplicar esa validación acá.
create or replace function public.get_agent_activity_summary(p_tenant_id uuid)
returns table (
  agent_id uuid,
  agent_name text,
  tasks_pending bigint,
  tasks_overdue bigint,
  tasks_completed_on_time bigint,
  tasks_completed_late bigint,
  appointments_pending bigint,
  appointments_overdue bigint,
  appointments_completed bigint
)
language sql
security invoker
set search_path = public
stable
as $$
  with task_stats as (
    select
      assigned_to as agent_id,
      count(*) filter (where status in ('pendiente', 'en_proceso') and due_date >= now()) as tasks_pending,
      count(*) filter (where status in ('pendiente', 'en_proceso') and due_date < now()) as tasks_overdue,
      count(*) filter (where status = 'completada' and completed_at <= due_date) as tasks_completed_on_time,
      count(*) filter (where status = 'completada' and completed_at > due_date) as tasks_completed_late
    from public.tasks
    where tenant_id = p_tenant_id and deleted_at is null and assigned_to is not null
    group by assigned_to
  ),
  appointment_stats as (
    select
      assigned_to as agent_id,
      count(*) filter (where status = 'activa' and scheduled_at >= now()) as appointments_pending,
      count(*) filter (where status = 'activa' and scheduled_at < now()) as appointments_overdue,
      count(*) filter (where status = 'completada') as appointments_completed
    from public.appointments
    where tenant_id = p_tenant_id and assigned_to is not null
    group by assigned_to
  )
  select
    p.id as agent_id,
    p.full_name as agent_name,
    coalesce(ts.tasks_pending, 0) as tasks_pending,
    coalesce(ts.tasks_overdue, 0) as tasks_overdue,
    coalesce(ts.tasks_completed_on_time, 0) as tasks_completed_on_time,
    coalesce(ts.tasks_completed_late, 0) as tasks_completed_late,
    coalesce(aps.appointments_pending, 0) as appointments_pending,
    coalesce(aps.appointments_overdue, 0) as appointments_overdue,
    coalesce(aps.appointments_completed, 0) as appointments_completed
  from public.profiles p
  left join task_stats ts on ts.agent_id = p.id
  left join appointment_stats aps on aps.agent_id = p.id
  where p.tenant_id = p_tenant_id
  order by p.full_name;
$$;
