-- Two independent improvements, bundled together because both came out of
-- the same request ("dejar la demo del Kanban mejor estructurada"):
--
-- 1) Pipeline stages have always shared the same default gray (#94A3B8,
--    from crm_pipeline_stages.color's column default) -- there was never a
--    real per-stage color anywhere. Gives every stage (existing tenants +
--    future ones, via seed_default_pipeline()) a distinct color so the
--    Kanban header dots and cards are visually scannable at a glance, same
--    idea as a traffic-light pipeline in most CRMs (cool colors early,
--    green won, red lost).
-- 2) The QA tenant's demo data (20260806000009_qa_admin_uno_demo_pipeline_data.sql)
--    seeded 6 contacts/conversations/opportunities but zero crm_tasks --
--    "Tareas pendientes" on the pipeline header and the Tareas screen were
--    both empty. Adds realistic follow-up tasks per case (mix of
--    pendiente/en_proceso/completada so the demo shows real progress, not
--    just a flat list), plus 2 general tasks not tied to any one deal.
--    Also fixes a small inconsistency from that migration: every
--    opportunity got the same generic description and the same
--    "current_date + 15 days" close date regardless of stage -- including
--    the already-closed Ganado/Perdido ones, which makes no sense for a
--    deal that's already won or lost. Gives each one a close date that
--    actually fits its stage and a description specific to its case.

update public.crm_pipeline_stages set color = '#8B5CF6' where name = 'Nuevo';
update public.crm_pipeline_stages set color = '#3B82F6' where name = 'Contactado';
update public.crm_pipeline_stages set color = '#F59E0B' where name = 'Propuesta';
update public.crm_pipeline_stages set color = '#F97316' where name = 'Negociación';
update public.crm_pipeline_stages set color = '#22C55E' where name = 'Ganado';
update public.crm_pipeline_stages set color = '#EF4444' where name = 'Perdido';

create or replace function public.seed_default_pipeline() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pipeline_id uuid;
begin
  insert into public.crm_pipelines (tenant_id, name) values (new.id, 'Ventas') returning id into v_pipeline_id;

  insert into public.crm_pipeline_stages (pipeline_id, name, display_order, color, probability, is_won, is_lost) values
    (v_pipeline_id, 'Nuevo', 0, '#8B5CF6', 10, false, false),
    (v_pipeline_id, 'Contactado', 1, '#3B82F6', 25, false, false),
    (v_pipeline_id, 'Propuesta', 2, '#F59E0B', 50, false, false),
    (v_pipeline_id, 'Negociación', 3, '#F97316', 75, false, false),
    (v_pipeline_id, 'Ganado', 4, '#22C55E', 100, true, false),
    (v_pipeline_id, 'Perdido', 5, '#EF4444', 0, false, true);

  return new;
end;
$$;

do $$
declare
  v_tenant_id uuid;
  v_admin_profile_id uuid;
  v_opp_id uuid;
  v_contact_id uuid;
begin
  select p.tenant_id, p.id into v_tenant_id, v_admin_profile_id
  from public.profiles p
  where p.email = 'qa-uno-admin@example.com';

  if v_tenant_id is null then
    raise exception 'No profile found for qa-uno-admin@example.com';
  end if;

  -- 1) Ana Gómez / Boutique Luna -- Nuevo, recién llegado.
  select id, contact_id into v_opp_id, v_contact_id
  from public.crm_opportunities
  where tenant_id = v_tenant_id and title = 'Cotización de vitrinas para tienda';
  if v_opp_id is null then raise exception 'Opportunity "Cotización de vitrinas para tienda" not found for tenant %', v_tenant_id; end if;

  update public.crm_opportunities
  set expected_close_date = current_date + interval '20 days',
      description = 'Ana pidió cotización para 4 vitrinas de 1.5m para su tienda. A la espera de enviarle la propuesta con precios y tiempos de entrega.'
  where id = v_opp_id;

  insert into public.crm_tasks (tenant_id, contact_id, opportunity_id, assigned_to, title, priority, status, due_date) values
    (v_tenant_id, v_contact_id, v_opp_id, v_admin_profile_id, 'Enviar cotización detallada de las 4 vitrinas', 'alta', 'pendiente', now() + interval '2 days'),
    (v_tenant_id, v_contact_id, v_opp_id, v_admin_profile_id, 'Confirmar medidas exactas del local', 'media', 'pendiente', now() + interval '1 day');

  -- 2) Carlos Ruiz / Café Aroma -- Contactado, esperando decisión.
  select id, contact_id into v_opp_id, v_contact_id
  from public.crm_opportunities
  where tenant_id = v_tenant_id and title = 'Suministro mensual de café en grano';
  if v_opp_id is null then raise exception 'Opportunity "Suministro mensual de café en grano" not found for tenant %', v_tenant_id; end if;

  update public.crm_opportunities
  set expected_close_date = current_date + interval '12 days',
      description = 'Carlos está evaluando portafolio y precios por volumen mensual junto a su socio. Quedó en confirmar esta semana.'
  where id = v_opp_id;

  insert into public.crm_tasks (tenant_id, contact_id, opportunity_id, assigned_to, title, priority, status, due_date) values
    (v_tenant_id, v_contact_id, v_opp_id, v_admin_profile_id, 'Dar seguimiento a la decisión con su socio', 'media', 'pendiente', now() + interval '3 days'),
    (v_tenant_id, v_contact_id, v_opp_id, v_admin_profile_id, 'Enviar muestra de café en grano', 'media', 'completada', now() - interval '2 days');

  -- 3) Marcela Torres / Clínica Vitalis -- Propuesta, revisando presupuesto.
  select id, contact_id into v_opp_id, v_contact_id
  from public.crm_opportunities
  where tenant_id = v_tenant_id and title = 'Equipos de fisioterapia';
  if v_opp_id is null then raise exception 'Opportunity "Equipos de fisioterapia" not found for tenant %', v_tenant_id; end if;

  update public.crm_opportunities
  set expected_close_date = current_date + interval '7 days',
      description = 'Propuesta de equipos de fisioterapia enviada y bien recibida. Marcela está revisando el presupuesto interno antes de confirmar; propuesta vigente por 15 días.'
  where id = v_opp_id;

  insert into public.crm_tasks (tenant_id, contact_id, opportunity_id, assigned_to, title, priority, status, due_date) values
    (v_tenant_id, v_contact_id, v_opp_id, v_admin_profile_id, 'Confirmar si aprobaron el presupuesto interno', 'alta', 'pendiente', now() + interval '5 days'),
    (v_tenant_id, v_contact_id, v_opp_id, v_admin_profile_id, 'Renovar vigencia de la propuesta si no responden', 'baja', 'pendiente', now() + interval '15 days');

  -- 4) Andrés Peña / Constructora Rivas -- Negociación, cerca de firmar.
  select id, contact_id into v_opp_id, v_contact_id
  from public.crm_opportunities
  where tenant_id = v_tenant_id and title = 'Suministro de materiales - Fase 2';
  if v_opp_id is null then raise exception 'Opportunity "Suministro de materiales - Fase 2" not found for tenant %', v_tenant_id; end if;

  update public.crm_opportunities
  set expected_close_date = current_date + interval '5 days',
      description = 'Andrés pidió mejorar el precio si se cierran las fases 1 y 2 juntas. Se ofreció 8% de descuento sobre el total; a la espera de la confirmación del gerente de obra.'
  where id = v_opp_id;

  insert into public.crm_tasks (tenant_id, contact_id, opportunity_id, assigned_to, title, priority, status, due_date) values
    (v_tenant_id, v_contact_id, v_opp_id, v_admin_profile_id, 'Preparar contrato con el 8% de descuento acordado', 'alta', 'en_proceso', now() + interval '2 days'),
    (v_tenant_id, v_contact_id, v_opp_id, v_admin_profile_id, 'Confirmar aprobación del gerente de obra', 'alta', 'pendiente', now() + interval '1 day');

  -- 5) Laura Méndez / Panadería Trigo Dorado -- Ganado, en entrega.
  select id, contact_id into v_opp_id, v_contact_id
  from public.crm_opportunities
  where tenant_id = v_tenant_id and title = 'Compra de horno industrial';
  if v_opp_id is null then raise exception 'Opportunity "Compra de horno industrial" not found for tenant %', v_tenant_id; end if;

  update public.crm_opportunities
  set expected_close_date = current_date - interval '18 days',
      description = 'Laura confirmó el pago del horno industrial. Cerrado y en proceso de coordinar la entrega e instalación.'
  where id = v_opp_id;

  insert into public.crm_tasks (tenant_id, contact_id, opportunity_id, assigned_to, title, priority, status, due_date) values
    (v_tenant_id, v_contact_id, v_opp_id, v_admin_profile_id, 'Coordinar entrega del horno industrial', 'alta', 'completada', now() - interval '15 days'),
    (v_tenant_id, v_contact_id, v_opp_id, v_admin_profile_id, 'Enviar factura y garantía del equipo', 'media', 'pendiente', now() + interval '2 days');

  -- 6) Jorge Salas / Taller JS Motos -- Perdido, oportunidad de reintentar.
  select id, contact_id into v_opp_id, v_contact_id
  from public.crm_opportunities
  where tenant_id = v_tenant_id and title = 'Repuestos importados';
  if v_opp_id is null then raise exception 'Opportunity "Repuestos importados" not found for tenant %', v_tenant_id; end if;

  update public.crm_opportunities
  set expected_close_date = current_date - interval '13 days',
      description = 'Jorge consiguió mejor precio con otro proveedor para los repuestos importados. Se cerró como perdida; dejar en radar para una futura cotización.'
  where id = v_opp_id;

  insert into public.crm_tasks (tenant_id, contact_id, opportunity_id, assigned_to, title, priority, status, due_date) values
    (v_tenant_id, v_contact_id, v_opp_id, v_admin_profile_id, 'Registrar motivo de la pérdida en el CRM', 'baja', 'completada', now() - interval '10 days'),
    (v_tenant_id, v_contact_id, v_opp_id, v_admin_profile_id, 'Reintentar contacto en 3 meses con nueva oferta', 'baja', 'pendiente', now() + interval '90 days');

  -- Tareas generales, sin contacto/oportunidad puntual.
  insert into public.crm_tasks (tenant_id, assigned_to, title, priority, status, due_date) values
    (v_tenant_id, v_admin_profile_id, 'Actualizar catálogo de precios del mes', 'media', 'pendiente', now() + interval '7 days'),
    (v_tenant_id, v_admin_profile_id, 'Revisar métricas del pipeline con el equipo', 'media', 'pendiente', now() + interval '4 days');

  raise notice 'Seeded 14 crm_tasks and refreshed close dates/descriptions for tenant %', v_tenant_id;
end $$;
