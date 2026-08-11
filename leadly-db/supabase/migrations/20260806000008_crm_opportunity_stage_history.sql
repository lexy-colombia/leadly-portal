-- Fase A (Kanban de Oportunidades, ver CLAUDE.md 3.7): without this, "tiempo
-- promedio en etapa" and "conversión" on the pipeline dashboard would be
-- fabricated numbers -- crm_opportunities only ever tracked the *current*
-- stage, never when it got there. A trigger logs every stage_id change
-- automatically so the frontend can never "forget" to record one (unlike if
-- this lived in application code across every place stage_id gets updated:
-- the Kanban drag-and-drop, the inline Select in Oportunidades.tsx, and any
-- future automation that moves a stage).
create table public.crm_opportunity_stage_history (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.crm_opportunities(id) on delete cascade,
  from_stage_id uuid references public.crm_pipeline_stages(id) on delete set null,
  to_stage_id uuid not null references public.crm_pipeline_stages(id) on delete restrict,
  changed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index crm_opportunity_stage_history_opportunity_id_idx on public.crm_opportunity_stage_history(opportunity_id);
create index crm_opportunity_stage_history_to_stage_id_idx on public.crm_opportunity_stage_history(to_stage_id);

alter table public.crm_opportunity_stage_history enable row level security;

-- Read-only from the app's perspective -- always written by the trigger
-- below, never inserted directly (same append-only spirit as
-- whatsapp_messages/crm_notes: no update/delete policy at all).
create policy crm_opportunity_stage_history_select on public.crm_opportunity_stage_history
  for select using (
    exists (
      select 1 from public.crm_opportunities o
      where o.id = crm_opportunity_stage_history.opportunity_id
      and (o.tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
    )
  );

revoke all on public.crm_opportunity_stage_history from anon;
revoke insert, update, delete on public.crm_opportunity_stage_history from authenticated;

create function public.log_opportunity_stage_change() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.stage_id is distinct from old.stage_id then
    insert into public.crm_opportunity_stage_history (opportunity_id, from_stage_id, to_stage_id, changed_by)
    values (new.id, old.stage_id, new.stage_id, auth.uid());
  end if;
  return new;
end;
$$;

create trigger crm_opportunities_log_stage_change
  after update on public.crm_opportunities
  for each row execute function public.log_opportunity_stage_change();

-- Also log the *initial* stage on creation (from_stage_id null) -- otherwise
-- an opportunity's time in its very first stage would be invisible to the
-- "tiempo promedio por etapa" calculation.
create function public.log_opportunity_initial_stage() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.crm_opportunity_stage_history (opportunity_id, from_stage_id, to_stage_id, changed_by)
  values (new.id, null, new.stage_id, auth.uid());
  return new;
end;
$$;

create trigger crm_opportunities_log_initial_stage
  after insert on public.crm_opportunities
  for each row execute function public.log_opportunity_initial_stage();

-- Backfill: opportunities created before this migration get one synthetic
-- "initial stage" row each, using their current stage_id and created_at
-- can't be reconstructed for created_at on the history row itself (defaults
-- to now()) -- acceptable: it only affects "tiempo promedio" for
-- pre-migration opportunities looking artificially fast, not conversión.
insert into public.crm_opportunity_stage_history (opportunity_id, from_stage_id, to_stage_id)
select id, null, stage_id from public.crm_opportunities where deleted_at is null;
