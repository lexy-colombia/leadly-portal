-- Demo data for the QA tenant (qa-uno-admin@example.com) so the Kanban has
-- something real to look at: one example contact+conversation+opportunity
-- per default pipeline stage (Nuevo/Contactado/Propuesta/Negociación/Ganado/
-- Perdido). Data-only migration, same defensive pattern as
-- 20260804000018/20260805000001 -- the `do` block below fails loudly (raise
-- exception) instead of silently doing nothing if the tenant/line/pipeline/
-- stages don't match what this session already set up for that tenant.
--
-- The seeding logic (contact + conversation + messages + opportunity) is
-- identical across all 6 examples, so it lives in a `pg_temp` (session-local)
-- helper function instead of being repeated inline 6 times -- created here as
-- a top-level statement (a `create function` can't be written directly
-- inside a plpgsql `do $$ ... end $$` body, only invoked via `perform`/
-- `execute`) and dropped again at the bottom so nothing permanent is added
-- to the schema.
create function pg_temp.seed_demo_case(
  p_tenant_id uuid,
  p_line_id uuid,
  p_admin_profile_id uuid,
  p_pipeline_id uuid,
  p_stage_id uuid,
  p_opp_status text,
  p_contact_name text,
  p_contact_phone text,
  p_contact_company text,
  p_contact_stage text,
  p_opp_title text,
  p_opp_value numeric,
  p_priority text,
  p_days_ago integer,
  p_messages jsonb
) returns void
language plpgsql
as $fn$
declare
  v_contact_id uuid;
  v_conv_id uuid;
  v_msg jsonb;
  v_ts timestamptz := now() - (p_days_ago || ' days')::interval;
begin
  insert into public.crm_contacts (tenant_id, full_name, phone, company, stage)
  values (p_tenant_id, p_contact_name, p_contact_phone, p_contact_company, p_contact_stage)
  returning id into v_contact_id;

  insert into public.whatsapp_conversations
    (tenant_id, whatsapp_line_id, contact_phone, contact_name, contact_id, mode, status, category, last_message_at)
  values
    (p_tenant_id, p_line_id, p_contact_phone, p_contact_name, v_contact_id, 'humano', 'open', 'venta', v_ts)
  returning id into v_conv_id;

  for v_msg in select * from jsonb_array_elements(p_messages) loop
    v_ts := v_ts + interval '25 minutes';
    insert into public.whatsapp_messages (conversation_id, direction, sender_type, sender_profile_id, content, created_at)
    values (
      v_conv_id,
      v_msg ->> 'direction',
      v_msg ->> 'sender_type',
      case when v_msg ->> 'sender_type' = 'agent' then p_admin_profile_id else null end,
      v_msg ->> 'content',
      v_ts
    );
  end loop;

  update public.whatsapp_conversations set last_message_at = v_ts where id = v_conv_id;

  insert into public.crm_opportunities
    (tenant_id, pipeline_id, stage_id, contact_id, title, value, priority, status, expected_close_date, description)
  values (
    p_tenant_id, p_pipeline_id, p_stage_id, v_contact_id, p_opp_title, p_opp_value, p_priority, p_opp_status,
    current_date + interval '15 days',
    'Caso de ejemplo generado para probar el tablero de oportunidades.'
  );
end;
$fn$;

do $$
declare
  v_tenant_id uuid;
  v_admin_profile_id uuid;
  v_line_id uuid;
  v_pipeline_id uuid;
  v_stage_nuevo uuid;
  v_stage_contactado uuid;
  v_stage_propuesta uuid;
  v_stage_negociacion uuid;
  v_stage_ganado uuid;
  v_stage_perdido uuid;
begin
  select p.tenant_id, p.id into v_tenant_id, v_admin_profile_id
  from public.profiles p
  where p.email = 'qa-uno-admin@example.com';

  if v_tenant_id is null then
    raise exception 'No profile found for qa-uno-admin@example.com';
  end if;

  select id into v_line_id from public.whatsapp_lines where tenant_id = v_tenant_id order by created_at limit 1;
  if v_line_id is null then
    raise exception 'No whatsapp_line found for tenant %', v_tenant_id;
  end if;

  select id into v_pipeline_id from public.crm_pipelines where tenant_id = v_tenant_id and is_active order by created_at limit 1;
  if v_pipeline_id is null then
    raise exception 'No active pipeline found for tenant %', v_tenant_id;
  end if;

  select id into v_stage_nuevo from public.crm_pipeline_stages where pipeline_id = v_pipeline_id and name = 'Nuevo';
  select id into v_stage_contactado from public.crm_pipeline_stages where pipeline_id = v_pipeline_id and name = 'Contactado';
  select id into v_stage_propuesta from public.crm_pipeline_stages where pipeline_id = v_pipeline_id and name = 'Propuesta';
  select id into v_stage_negociacion from public.crm_pipeline_stages where pipeline_id = v_pipeline_id and name = 'Negociación';
  select id into v_stage_ganado from public.crm_pipeline_stages where pipeline_id = v_pipeline_id and name = 'Ganado';
  select id into v_stage_perdido from public.crm_pipeline_stages where pipeline_id = v_pipeline_id and name = 'Perdido';

  if v_stage_nuevo is null or v_stage_contactado is null or v_stage_propuesta is null
     or v_stage_negociacion is null or v_stage_ganado is null or v_stage_perdido is null then
    raise exception 'Pipeline % is missing one of the expected default stage names', v_pipeline_id;
  end if;

  perform pg_temp.seed_demo_case(
    v_tenant_id, v_line_id, v_admin_profile_id, v_pipeline_id, v_stage_nuevo, 'open',
    'Ana Gómez', '573000000001', 'Boutique Luna', 'lead',
    'Cotización de vitrinas para tienda', 2500000, 'media', 2,
    '[
      {"direction": "inbound", "sender_type": "contact", "content": "Hola, buenas tardes. Vi su catálogo y me interesa cotizar vitrinas para mi tienda."},
      {"direction": "outbound", "sender_type": "agent", "content": "¡Hola Ana! Claro que sí, con gusto te ayudo. ¿Cuántas vitrinas necesitás y de qué tamaño aproximado?"},
      {"direction": "inbound", "sender_type": "contact", "content": "Serían 4 vitrinas, de más o menos 1.5 metros cada una."}
    ]'::jsonb
  );

  perform pg_temp.seed_demo_case(
    v_tenant_id, v_line_id, v_admin_profile_id, v_pipeline_id, v_stage_contactado, 'open',
    'Carlos Ruiz', '573000000002', 'Café Aroma', 'contactado',
    'Suministro mensual de café en grano', 1800000, 'media', 5,
    '[
      {"direction": "inbound", "sender_type": "contact", "content": "Buenas, necesitamos un proveedor fijo de café en grano para el local."},
      {"direction": "outbound", "sender_type": "agent", "content": "Hola Carlos, te comparto nuestro portafolio de cafés y precios por volumen mensual."},
      {"direction": "inbound", "sender_type": "contact", "content": "Perfecto, lo reviso con mi socio y te confirmo esta semana."},
      {"direction": "outbound", "sender_type": "agent", "content": "Genial, quedo atento. Cualquier duda me escribís."}
    ]'::jsonb
  );

  perform pg_temp.seed_demo_case(
    v_tenant_id, v_line_id, v_admin_profile_id, v_pipeline_id, v_stage_propuesta, 'open',
    'Marcela Torres', '573000000003', 'Clínica Vitalis', 'negociacion',
    'Equipos de fisioterapia', 6300000, 'alta', 8,
    '[
      {"direction": "inbound", "sender_type": "contact", "content": "Hola, ya recibimos la propuesta que nos enviaron para los equipos de fisioterapia."},
      {"direction": "outbound", "sender_type": "agent", "content": "Hola Marcela, perfecto. Cualquier ajuste que necesiten en la propuesta me contás."},
      {"direction": "inbound", "sender_type": "contact", "content": "Nos gustó, solo estamos revisando el presupuesto internamente antes de confirmar."},
      {"direction": "outbound", "sender_type": "agent", "content": "Sin problema, la propuesta queda vigente por 15 días. Quedo pendiente."}
    ]'::jsonb
  );

  perform pg_temp.seed_demo_case(
    v_tenant_id, v_line_id, v_admin_profile_id, v_pipeline_id, v_stage_negociacion, 'open',
    'Andrés Peña', '573000000004', 'Constructora Rivas', 'negociacion',
    'Suministro de materiales - Fase 2', 12000000, 'alta', 12,
    '[
      {"direction": "inbound", "sender_type": "contact", "content": "Buenas, con respecto a la fase 2 del proyecto, ¿nos pueden mejorar el precio si cerramos todo el contrato de una vez?"},
      {"direction": "outbound", "sender_type": "agent", "content": "Hola Andrés, sí es posible. Si cerramos las dos fases juntas te puedo ofrecer un 8% de descuento sobre el total."},
      {"direction": "inbound", "sender_type": "contact", "content": "Nos interesa. Déjame confirmarlo con el gerente de obra y te digo mañana."},
      {"direction": "outbound", "sender_type": "agent", "content": "Perfecto, quedo atento a tu confirmación para preparar el contrato."}
    ]'::jsonb
  );

  perform pg_temp.seed_demo_case(
    v_tenant_id, v_line_id, v_admin_profile_id, v_pipeline_id, v_stage_ganado, 'won',
    'Laura Méndez', '573000000005', 'Panadería Trigo Dorado', 'cliente',
    'Compra de horno industrial', 8500000, 'alta', 20,
    '[
      {"direction": "inbound", "sender_type": "contact", "content": "Hola, ya hicimos la transferencia por el horno industrial que hablamos."},
      {"direction": "outbound", "sender_type": "agent", "content": "¡Excelente Laura! Ya la vemos reflejada. Coordinamos la entrega para esta semana."},
      {"direction": "inbound", "sender_type": "contact", "content": "Muchas gracias, quedamos muy contentos con la atención."},
      {"direction": "outbound", "sender_type": "agent", "content": "¡Un gusto! Cualquier cosa que necesiten, con toda confianza nos escriben."}
    ]'::jsonb
  );

  perform pg_temp.seed_demo_case(
    v_tenant_id, v_line_id, v_admin_profile_id, v_pipeline_id, v_stage_perdido, 'lost',
    'Jorge Salas', '573000000006', 'Taller JS Motos', 'perdido',
    'Repuestos importados', 3000000, 'baja', 15,
    '[
      {"direction": "inbound", "sender_type": "contact", "content": "Hola, gracias por la cotización de los repuestos, pero finalmente conseguimos mejor precio con otro proveedor."},
      {"direction": "outbound", "sender_type": "agent", "content": "Entiendo Jorge, gracias por avisarnos. Quedamos atentos para una próxima oportunidad."},
      {"direction": "inbound", "sender_type": "contact", "content": "Claro, cualquier cosa los tengo en cuenta. Gracias."}
    ]'::jsonb
  );

  raise notice 'Seeded 6 demo contacts/conversations/opportunities for tenant %', v_tenant_id;
end $$;

drop function pg_temp.seed_demo_case(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, text, numeric, text, integer, jsonb);
