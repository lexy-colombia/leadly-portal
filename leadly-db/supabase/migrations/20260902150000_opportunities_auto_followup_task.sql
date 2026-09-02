-- Una oportunidad sola no le dice a un agente humano qué hacer con ella.
-- Hasta ahora nada garantizaba que una oportunidad nueva tuviera una tarea
-- de seguimiento asociada: create_opportunity (tool de IA, caso de interés
-- claro -- el camino que se toma en la mayoría de los casos reales) nunca
-- creaba una, solo flag_interest_for_followup (interés ambiguo) lo hacía; y
-- una oportunidad creada a mano desde el Kanban (OpportunityDrawer) tampoco
-- generaba ninguna. Encontrado en vivo con Pragma Consulting: la IA creó/
-- verificó la oportunidad de un lead real (SG-SST, interés claro) y no quedó
-- ninguna tarea -- un agente humano no tenía ninguna señal en Tareas/
-- Calendario de que había algo que hacer.
--
-- Pedido explícito del usuario: "oportunidades, calendario y tareas debe ser
-- transversal... no debe bastar solo con tener la oportunidad", y sin
-- agregarle más tools al modelo de IA (ya tiene bastantes -- más aumenta el
-- riesgo de que llame la equivocada o se pierda un paso, mismo problema que
-- motivó este fix). Se resuelve al nivel de esquema con un trigger, no en el
-- código de las tools ni en el prompt: así aplica sin importar el origen de
-- la oportunidad (IA o un agente creándola a mano), mismo criterio que
-- "crm_orders confirmada -> oportunidad Ganado" (20260809170000_crm_orders_
-- confirmed_moves_opportunity.sql) -- un trigger centralizado que cubre
-- todos los caminos por igual en vez de confiar en que cada caller se
-- acuerde de hacer el segundo paso.
--
-- No dispara en UPDATE: create_opportunity reutiliza (UPDATE) la oportunidad
-- abierta existente del contacto en vez de duplicarla -- reabrir/actualizar
-- una oportunidad ya en curso no debe generar una tarea nueva cada vez.
create or replace function public.create_followup_task_for_new_opportunity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_assigned_to uuid;
begin
  v_assigned_to := new.owner_id;
  if v_assigned_to is null then
    select assigned_to into v_assigned_to from public.clients where id = new.contact_id;
  end if;

  insert into public.tasks (tenant_id, contact_id, opportunity_id, assigned_to, title, description, priority, due_date)
  values (
    new.tenant_id,
    new.contact_id,
    new.id,
    v_assigned_to,
    'Dar seguimiento: ' || new.title,
    new.description,
    new.priority,
    now() + interval '1 day'
  );
  return new;
end;
$$;

create trigger opportunities_create_followup_task
  after insert on public.opportunities
  for each row execute function public.create_followup_task_for_new_opportunity();
