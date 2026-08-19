-- Fusión Tareas -> Calendario (2026-08-19): el calendario pasa a ser la
-- única vista de tareas, y una tarea sin due_date no tiene dónde caer en la
-- grilla mes/semana/día. due_date pasa a ser obligatorio -- backfill
-- defensivo (asigna "ahora" a lo que haya quedado sin fecha) antes del
-- NOT NULL, aunque hoy no existe ninguna fila así.
update public.tasks set due_date = now() where due_date is null;

alter table public.tasks alter column due_date set not null;
