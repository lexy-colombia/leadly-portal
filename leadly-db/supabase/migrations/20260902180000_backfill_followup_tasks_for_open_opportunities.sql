-- Backfill de opportunities_create_followup_task (20260902150000): ese
-- trigger solo dispara hacia adelante (after insert), así que las
-- oportunidades abiertas creadas ANTES de esa migración -- incluida la de
-- Pragma Consulting (SG-SST) que originó todo este trabajo -- se quedaron
-- sin tarea de seguimiento. Pedido explícito del usuario: "las tareas
-- pendientes de todas las empresas, ajustalo a que queden con lo que se
-- pide ahora" -- alinear los datos existentes de TODOS los tenants con la
-- regla nueva, no solo aplicarla desde hoy en adelante. Mismo criterio
-- exacto que create_followup_task_for_new_opportunity() (mismo título,
-- misma resolución de responsable, mismo vencimiento a 24h) para que no
-- haya dos caminos con reglas distintas.
insert into public.tasks (tenant_id, contact_id, opportunity_id, assigned_to, title, description, priority, due_date)
select
  o.tenant_id,
  o.contact_id,
  o.id,
  coalesce(o.owner_id, c.assigned_to),
  'Dar seguimiento: ' || o.title,
  o.description,
  o.priority,
  now() + interval '1 day'
from public.opportunities o
left join public.clients c on c.id = o.contact_id
left join public.tasks tk on tk.opportunity_id = o.id and tk.deleted_at is null
where o.status = 'open' and o.deleted_at is null and tk.id is null;
