-- Agendamiento real de citas -- pedido explícito del usuario (2026-09-06):
-- hasta ahora una cita era un único instante (scheduled_at) sin hora de fin,
-- así que no había forma de saber cuánto dura ni de dibujar un bloque real
-- en la grilla horaria del Calendario. Se agrega `ends_at` (mismo día,
-- siempre calculado a partir de scheduled_at) y `opportunity_id` (mismo
-- patrón que ya tiene tasks.opportunity_id) para que una cita, igual que una
-- tarea, pueda quedar vinculada al seguimiento de una oportunidad concreta.

alter table public.appointments
  add column ends_at timestamptz,
  add column opportunity_id uuid references public.opportunities(id) on delete set null;

-- Backfill de las citas existentes antes de poder exigir NOT NULL.
update public.appointments set ends_at = scheduled_at + interval '30 minutes' where ends_at is null;

alter table public.appointments alter column ends_at set not null;

-- El tool-calling de IA (book_appointment, whatsapp-ai-tools/index.ts) sigue
-- mandando solo scheduled_at/notes -- este trigger es lo que le da una
-- duración por defecto sin tener que tocar ese código (exponerle duración/
-- oportunidad a la IA queda para una fase posterior, mismo criterio que el
-- resto del tool-calling del proyecto).
create or replace function public.appointments_default_ends_at() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.ends_at is null then
    new.ends_at := new.scheduled_at + interval '30 minutes';
  end if;
  return new;
end;
$$;

create trigger appointments_default_ends_at before insert on public.appointments
  for each row execute function public.appointments_default_ends_at();

create index appointments_opportunity_id_idx on public.appointments(opportunity_id);
