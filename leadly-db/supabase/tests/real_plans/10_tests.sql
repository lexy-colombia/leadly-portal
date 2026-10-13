set client_min_messages = notice;
create or replace function t.fp(p_k text) returns text language sql stable as $$
  select case p_k
    when 'tem' then (select md5(coalesce(string_agg(m::text, '|' order by m.tenant_id, m.module_key), '')) from public.tenant_enabled_modules m)
    when 'subs' then (select md5(coalesce(string_agg(s::text, '|' order by s.id), '')) from public.billing_subscriptions s)
    when 'inv' then (select md5(coalesce(string_agg(i::text, '|' order by i.id), '')) from public.payment_invoices i)
    when 'items' then (select md5(coalesce(string_agg(i::text, '|' order by i.id), '')) from public.payment_invoice_items i)
    when 'test_plans' then (select md5(coalesce(string_agg(
        (id, amount_cents, currency, billing_interval, max_users, max_whatsapp_lines, setup_fee_cents,
         is_custom, max_warehouses, max_pos_points, max_ai_agents, max_ai_messages_month, sort_order)::text,
        '|' order by id), '')) from public.billing_plans where id in (
          '11111111-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000002','11111111-0000-0000-0000-000000000003'))
  end $$;
create or replace function t.mods_of(p_key text) returns text language sql stable as $$
  select coalesce(string_agg(pm.module_key, ',' order by pm.module_key), '')
  from public.billing_plan_modules pm join public.billing_plans p on p.id = pm.plan_id where p.key = p_key $$;

do $$
declare
  v_starter text := 'billing,contacts,credit,dashboard,expenses,inventory,pos,products,reports,returns,sales,settings';
  v_business text;
  v_ai text;
  r record;
begin
  v_business := (select string_agg(x, ',' order by x) from unnest(string_to_array(v_starter, ',') ||
      array['dispatches','einvoicing','storefront','integrations']) x);
  v_ai := (select string_agg(x, ',' order by x) from unnest(string_to_array(v_business, ',') ||
      array['conversations','channels','aiAgents']) x);

  perform t.chk('1 hay 7 planes', (select count(*) from public.billing_plans) = 7, (select count(*) from public.billing_plans)::text);
  perform t.chk('2 4 reales activos y publicos',
    (select count(*) from public.billing_plans where key in ('starter','business','business_ai','enterprise') and is_active and is_public) = 4);
  perform t.chk('3 3 de prueba inactivos y no publicos con key/name nuevos',
    (select count(*) from public.billing_plans where key in ('starter_prueba','growth_prueba','scale_prueba') and not is_active and not is_public) = 3
    and (select name from public.billing_plans where key = 'starter_prueba') = 'Starter (prueba)'
    and (select name from public.billing_plans where key = 'growth_prueba') = 'Growth (prueba)'
    and (select name from public.billing_plans where key = 'scale_prueba') = 'Scale (prueba)');
  perform t.chk('4 las keys viejas ya no existen', not exists (select 1 from public.billing_plans where key in ('Starter','GROWTH','SCALE')));
  perform t.chk('5 los de prueba conservan precio/limites exactos (huella)', t.fp('test_plans') = (select h from t.fp_before where k = 'test_plans'));
  perform t.chk('6 las 2 suscripciones siguen en el plan de prueba (mismo plan_id)',
    (select count(*) from public.billing_subscriptions where plan_id = '11111111-0000-0000-0000-000000000001') = 2);
  perform t.chk('7 huella tenant_enabled_modules identica', t.fp('tem') = (select h from t.fp_before where k = 'tem'));
  perform t.chk('8 huella billing_subscriptions identica', t.fp('subs') = (select h from t.fp_before where k = 'subs'));
  perform t.chk('9 huella payment_invoices identica', t.fp('inv') = (select h from t.fp_before where k = 'inv'));
  perform t.chk('9b huella payment_invoice_items identica', t.fp('items') = (select h from t.fp_before where k = 'items'));
  perform t.chk('10 planes de prueba sin modulos',
    not exists (select 1 from public.billing_plan_modules pm join public.billing_plans p on p.id = pm.plan_id where p.key like '%\_prueba'));

  -- Precios y limites
  perform t.chk('11 Starter', (select (amount_cents, setup_fee_cents, is_custom, max_users, max_warehouses, max_pos_points,
      max_whatsapp_lines, max_ai_agents, max_ai_messages_month, sort_order, billing_interval, currency)::text
      from public.billing_plans where key = 'starter') = '(6990000,15000000,f,2,1,1,0,0,0,10,monthly,COP)',
      (select (amount_cents, setup_fee_cents)::text from public.billing_plans where key = 'starter'));
  perform t.chk('12 Business', (select (amount_cents, setup_fee_cents, is_custom, max_users, max_warehouses, max_pos_points,
      max_whatsapp_lines, max_ai_agents, max_ai_messages_month, sort_order, billing_interval, currency)::text
      from public.billing_plans where key = 'business') = '(14000000,35000000,f,5,2,1,0,0,0,20,monthly,COP)');
  perform t.chk('13 Business AI', (select (amount_cents, setup_fee_cents, is_custom, max_users, max_warehouses, max_pos_points,
      max_whatsapp_lines, max_ai_agents, max_ai_messages_month, sort_order, billing_interval, currency)::text
      from public.billing_plans where key = 'business_ai') = '(29900000,90000000,f,5,2,1,1,1,,30,monthly,COP)');
  perform t.chk('14 Enterprise', (select (amount_cents, setup_fee_cents, is_custom, max_users, max_warehouses, max_pos_points,
      max_whatsapp_lines, max_ai_agents, max_ai_messages_month, sort_order, billing_interval, currency)::text
      from public.billing_plans where key = 'enterprise') = '(0,0,t,,,,,,,40,monthly,COP)');
  perform t.chk('15 nombres exactos',
    (select string_agg(name, '|' order by sort_order) from public.billing_plans where is_public) = 'Starter|Business|Business AI|Enterprise');
  perform t.chk('16 descripciones = audience de la pagina',
    (select description from public.billing_plans where key = 'starter') = 'Para tiendas y pequeños comercios.'
    and (select description from public.billing_plans where key = 'business') = 'Para negocios que quieren crecer.'
    and (select description from public.billing_plans where key = 'business_ai') = 'Configuramos un agente de IA para que sea el trabajador estrella de tu empresa.'
    and (select description from public.billing_plans where key = 'enterprise') = 'Equipos, sedes y procesos conectados.');

  -- Modulos
  perform t.chk('17 modulos Starter', t.mods_of('starter') = v_starter, t.mods_of('starter'));
  perform t.chk('18 modulos Business', t.mods_of('business') = v_business, t.mods_of('business'));
  perform t.chk('19 modulos Business AI', t.mods_of('business_ai') = v_ai, t.mods_of('business_ai'));
  perform t.chk('20 Enterprise sin modulos', t.mods_of('enterprise') = '');
  perform t.chk('21 ningun plan incluye pipeline/tasks/calendar/campaigns/automations',
    not exists (select 1 from public.billing_plan_modules where module_key in ('pipeline','tasks','calendar','campaigns','automations')));
  perform t.chk('22 conteos 12/16/19',
    (select count(*) from public.billing_plan_modules pm join public.billing_plans p on p.id = pm.plan_id where p.key = 'starter') = 12
    and (select count(*) from public.billing_plan_modules pm join public.billing_plans p on p.id = pm.plan_id where p.key = 'business') = 16
    and (select count(*) from public.billing_plan_modules pm join public.billing_plans p on p.id = pm.plan_id where p.key = 'business_ai') = 19);
  perform t.chk('23 planes reales sin suscripciones',
    not exists (select 1 from public.billing_subscriptions s join public.billing_plans p on p.id = s.plan_id where p.is_public));
end $$;
