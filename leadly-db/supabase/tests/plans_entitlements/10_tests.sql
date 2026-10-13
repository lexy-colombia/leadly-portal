set client_min_messages = notice;
create or replace function t.tid(p text) returns uuid language sql stable security definer as $$ select id from public.tenants where name = p $$;
create or replace function t.sid(p text) returns uuid language sql stable security definer as
$$ select id from public.billing_subscriptions where tenant_id = t.tid(p) order by created_at desc, id limit 1 $$;
create or replace function t.mods(p text) returns text language sql stable as
$$ select coalesce(string_agg(module_key || ':' || source, ',' order by module_key), '') from public.tenant_enabled_modules where tenant_id = t.tid(p) $$;
create or replace function t.items(p_inv uuid) returns text language sql stable as
$$ select coalesce(string_agg(description || '=' || subtotal_cents, ' | ' order by display_order, description), '') from public.payment_invoice_items where invoice_id = p_inv $$;

\echo '== 1. GRANDFATHERING (tras aplicar la migracion sobre datos vivos)'
do $$
declare v_before int; v_after int; v_diff int; r record;
begin
  select count(*) into v_before from t.snap_before;
  select count(*) into v_after from public.tenant_enabled_modules;
  perform t.chk('1.1 mismo numero de filas de tenant_enabled_modules', v_before = v_after, v_before || ' vs ' || v_after);
  select count(*) into v_diff from (
    (select tenant_id, module_key from t.snap_before except select tenant_id, module_key from public.tenant_enabled_modules)
    union all
    (select tenant_id, module_key from public.tenant_enabled_modules except select tenant_id, module_key from t.snap_before)) d;
  perform t.chk('1.2 el conjunto de modulos de cada comercio no cambia', v_diff = 0, 'diferencias=' || v_diff);
  perform t.chk('1.3 todas las filas existentes quedan source=manual',
    not exists (select 1 from public.tenant_enabled_modules where source <> 'manual'));
  perform t.chk('1.4 suscripciones existentes quedan con setup_fee_billed_at (no se les cobrara implementacion)',
    not exists (select 1 from public.billing_subscriptions where setup_fee_billed_at is null));
  select count(*) into v_diff from (
    (select id, subscription_id, amount_cents, status from t.snap_invoices_before except select id, subscription_id, amount_cents, status from public.payment_invoices)) d;
  perform t.chk('1.5 facturas existentes intactas', v_diff = 0 and (select count(*) from t.snap_invoices_before) = (select count(*) from public.payment_invoices));
  perform t.chk('1.6 planes de prueba intactos (precio y limites), columnas nuevas con defaults neutros',
    (select count(*) from public.billing_plans where key in ('starter','growth','scale')
       and setup_fee_cents = 0 and is_custom = false and is_public and max_warehouses is null and max_pos_points is null
       and max_ai_agents is null and max_ai_messages_month is null) = 3
    and (select amount_cents from public.billing_plans where key = 'starter') = 19900000
    and (select max_whatsapp_lines from public.billing_plans where key = 'starter') = 1
    and (select max_users from public.billing_plans where key = 'growth') = 10);
end $$;

-- Disparadores re-sincronizando comercios legados: no deben mover nada.
update public.billing_subscriptions set status = 'PAST_DUE' where id = 'bbbbbbbb-0000-0000-0000-00000000000a';
update public.billing_subscriptions set status = 'ACTIVE' where id = 'bbbbbbbb-0000-0000-0000-00000000000a';
update public.billing_subscriptions set plan_id = '11111111-0000-0000-0000-000000000002' where id = 'bbbbbbbb-0000-0000-0000-00000000000a';
update public.billing_subscriptions set plan_id = '11111111-0000-0000-0000-000000000001' where id = 'bbbbbbbb-0000-0000-0000-00000000000a';
do $$
declare v_diff int;
begin
  select count(*) into v_diff from (
    (select tenant_id, module_key from t.snap_before except select tenant_id, module_key from public.tenant_enabled_modules)
    union all
    (select tenant_id, module_key from public.tenant_enabled_modules except select tenant_id, module_key from t.snap_before)) d;
  perform t.chk('1.7 cambiar estado/plan de una suscripcion legada (re-sync) no cambia sus modulos', v_diff = 0);
end $$;

-- CHECK de module_key ampliado
do $$
begin
  insert into public.tenant_enabled_modules(tenant_id, module_key) values ('aaaaaaaa-0000-0000-0000-00000000000d', 'einvoicing');
  insert into public.tenant_enabled_modules(tenant_id, module_key) values ('aaaaaaaa-0000-0000-0000-00000000000d', 'storefront');
  perform t.chk('1.8 CHECK acepta einvoicing y storefront', true);
  perform t.expect_error('1.9 CHECK sigue rechazando claves inventadas',
    $q$insert into public.tenant_enabled_modules(tenant_id, module_key) values ('aaaaaaaa-0000-0000-0000-00000000000d', 'bogus')$q$, '%tenant_enabled_modules_module_key_check%');
  delete from public.tenant_enabled_modules where tenant_id = 'aaaaaaaa-0000-0000-0000-00000000000d' and module_key in ('einvoicing','storefront');
end $$;

\echo '== 2. Catalogo nuevo: planes y modulos (como superadmin autenticado)'
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
insert into public.billing_plans(key, name, amount_cents, billing_interval, setup_fee_cents, max_users, max_warehouses, max_pos_points, max_whatsapp_lines, max_ai_agents, max_ai_messages_month, sort_order) values
 ('starter_n','Starter · Operar',6990000,'monthly',15000000,2,1,1,0,0,0,1),
 ('business_n','Business · Formalizar',14000000,'monthly',35000000,5,2,1,0,0,0,2),
 ('business_ai_n','Business AI · Conversar',29900000,'monthly',90000000,5,2,1,1,1,null,3),
 ('nosetup_n','Sin implementacion',5000000,'monthly',0,null,null,null,null,null,null,4),
 ('zero_n','Gratis',0,'monthly',0,null,null,null,null,null,null,5),
 ('zero_setup_n','Gratis con implementacion',0,'monthly',500000,null,null,null,null,null,null,6),
 ('toggle_n','Para probar is_custom',1000000,'monthly',0,null,null,null,null,null,null,7);
insert into public.billing_plans(key, name, amount_cents, billing_interval, is_custom, sort_order) values
 ('enterprise_n','Enterprise · Escalar',0,'monthly',true,9);

insert into public.billing_plan_modules(plan_id, module_key)
select p.id, m from public.billing_plans p, unnest(array['dashboard','products','sales','pos']) m where p.key in ('starter_n','nosetup_n');
insert into public.billing_plan_modules(plan_id, module_key)
select p.id, m from public.billing_plans p, unnest(array['dashboard','products','sales','pos','dispatches','einvoicing','storefront']) m where p.key = 'business_n';
insert into public.billing_plan_modules(plan_id, module_key)
select p.id, m from public.billing_plans p, unnest(array['dashboard','products','sales','pos','dispatches','einvoicing','storefront','conversations','aiAgents']) m where p.key = 'business_ai_n';
insert into public.billing_plan_modules(plan_id, module_key)
select p.id, 'dashboard' from public.billing_plans p where p.key in ('zero_n','zero_setup_n');
insert into public.billing_plan_modules(plan_id, module_key)
select p.id, m from public.billing_plans p, unnest(array['dashboard','reports']) m where p.key = 'toggle_n';
select t.chk('2.1 limites 0 y NULL aceptados; setup/limites persisten',
  (select max_whatsapp_lines = 0 and max_ai_messages_month = 0 and setup_fee_cents = 15000000 from public.billing_plans where key='starter_n')
  and (select max_ai_messages_month is null from public.billing_plans where key='business_ai_n'));
reset role;
do $$
begin
  perform t.expect_error('2.2 max_whatsapp_lines negativo rechazado',
    $q$insert into public.billing_plans(key,name,amount_cents,billing_interval,max_whatsapp_lines) values ('neg','neg',1,'monthly',-1)$q$, '%max_whatsapp_lines_check%');
  perform t.expect_error('2.3 max_users = 0 sigue rechazado (> 0 o NULL)',
    $q$insert into public.billing_plans(key,name,amount_cents,billing_interval,max_users) values ('neg2','neg2',1,'monthly',0)$q$, '%max_users_check%');
  perform t.expect_error('2.4 module_key invalido en billing_plan_modules rechazado',
    $q$insert into public.billing_plan_modules(plan_id, module_key) select id,'bogus' from public.billing_plans where key='starter_n'$q$, '%billing_plan_modules_module_key_check%');
end $$;

\echo '== 3. Sync no toca manual / apply / preview (comercio B en plan Starter)'
insert into public.tenants(name) values ('B');
insert into public.tenant_enabled_modules(tenant_id, module_key) values (t.tid('B'),'reports'),(t.tid('B'),'sales');   -- manuales
insert into public.billing_subscriptions(tenant_id, plan_id)
  select t.tid('B'), id from public.billing_plans where key = 'starter_n';
do $$
declare v_inv uuid; v_n int;
begin
  perform t.chk('3.1 suscripcion nueva sincroniza: plan agrega faltantes y conserva manuales',
    t.mods('B') = 'dashboard:plan,pos:plan,products:plan,reports:manual,sales:manual', t.mods('B'));
  perform t.chk('3.2 sync no tocó source=manual (sales sigue manual aunque el plan lo incluya)',
    (select source from public.tenant_enabled_modules where tenant_id = t.tid('B') and module_key = 'sales') = 'manual');
  -- primera factura con implementacion
  select id into v_inv from public.payment_invoices where subscription_id = t.sid('B');
  perform t.chk('3.3 primera factura: monto = plan + implementacion (6.990.000 + 15.000.000)',
    (select amount_cents from public.payment_invoices where id = v_inv) = 21990000, 'amount=' || (select amount_cents from public.payment_invoices where id = v_inv));
  perform t.chk('3.4 primera factura: 2 items (plan + Implementacion) y suman el monto',
    (select count(*) from public.payment_invoice_items where invoice_id = v_inv) = 2
    and (select sum(subtotal_cents) from public.payment_invoice_items where invoice_id = v_inv) = 21990000, t.items(v_inv));
  perform t.chk('3.5 setup_fee_billed_at fijado y suscripcion sigue PENDING_PAYMENT',
    (select setup_fee_billed_at is not null and status = 'PENDING_PAYMENT' from public.billing_subscriptions where id = t.sid('B')));
  raise notice 'items 1a factura B: %', t.items(v_inv);
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
delete from public.tenant_enabled_modules where tenant_id = t.tid('B') and module_key = 'dashboard';   -- falta uno del plan
do $$
declare v_before text; v_prev jsonb; v_apply jsonb; v_rows int;
begin
  v_before := t.mods('B');
  v_prev := public.preview_apply_plan_to_tenant(t.tid('B'));
  raise notice 'preview B: %', v_prev;
  perform t.chk('3.6 preview no escribe', t.mods('B') = v_before, t.mods('B'));
  perform t.chk('3.7 preview: to_add=[dashboard], to_remove_if_replace=[reports], kept_manual=[reports,sales]',
    v_prev -> 'to_add' = '["dashboard"]'::jsonb and v_prev -> 'to_remove_if_replace' = '["reports"]'::jsonb
    and v_prev -> 'kept_manual' = '["reports","sales"]'::jsonb, v_prev::text);
  v_apply := public.apply_plan_to_tenant(t.tid('B'), false);
  raise notice 'apply(false) B: %', v_apply;
  perform t.chk('3.8 apply sin replace agrega faltantes y conserva manuales',
    t.mods('B') = 'dashboard:plan,pos:plan,products:plan,reports:manual,sales:manual' and v_apply -> 'added' = '["dashboard"]'::jsonb, t.mods('B'));
  v_apply := public.apply_plan_to_tenant(t.tid('B'), true);
  raise notice 'apply(true) B: %', v_apply;
  perform t.chk('3.9 apply con replace elimina manuales fuera del plan y gestiona los que si estan',
    t.mods('B') = 'dashboard:plan,pos:plan,products:plan,sales:plan'
    and v_apply -> 'removed_manual' = '["reports"]'::jsonb and v_apply -> 'converted_manual' = '["sales"]'::jsonb, t.mods('B'));
end $$;
reset role;

\echo '== 4. Cambio de plan y edicion de modulos de un plan re-sincronizan'
insert into public.tenants(name) values ('G');
insert into public.tenant_enabled_modules(tenant_id, module_key) values (t.tid('G'),'campaigns');   -- manual en G
insert into public.billing_subscriptions(tenant_id, plan_id) select t.tid('G'), id from public.billing_plans where key = 'business_n';
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
update public.billing_subscriptions set plan_id = (select id from public.billing_plans where key = 'business_n') where id = t.sid('B');
select t.chk('4.1 cambiar el plan de una suscripcion re-sincroniza (B Starter -> Business)',
  t.mods('B') = 'dashboard:plan,dispatches:plan,einvoicing:plan,pos:plan,products:plan,sales:plan,storefront:plan', t.mods('B'));
select t.chk('4.2 comercio G (manual campaigns + plan Business) correcto',
  t.mods('G') = 'campaigns:manual,dashboard:plan,dispatches:plan,einvoicing:plan,pos:plan,products:plan,sales:plan,storefront:plan', t.mods('G'));
insert into public.billing_plan_modules(plan_id, module_key) select id, 'reports' from public.billing_plans where key = 'business_n';
select t.chk('4.3 INSERT en billing_plan_modules re-sincroniza a TODOS los comercios del plan',
  t.mods('B') like '%reports:plan%' and t.mods('G') like '%reports:plan%', t.mods('B') || ' // ' || t.mods('G'));
select t.chk('4.4 comercios de otros planes no se ven afectados (legado A)',
  t.mods('Legacy A (TecnoNova-like)') = 'campaigns:manual,conversations:manual,dashboard:manual,pos:manual,sales:manual', t.mods('Legacy A (TecnoNova-like)'));
update public.billing_plan_modules set module_key = 'credit' where module_key = 'reports' and plan_id = (select id from public.billing_plans where key = 'business_n');
select t.chk('4.5 UPDATE de billing_plan_modules re-sincroniza (reports -> credit)',
  t.mods('B') like '%credit:plan%' and t.mods('B') not like '%reports%' and t.mods('G') like '%credit:plan%', t.mods('B'));
delete from public.billing_plan_modules where module_key = 'credit' and plan_id = (select id from public.billing_plans where key = 'business_n');
select t.chk('4.6 DELETE de billing_plan_modules quita solo lo gestionado; manual de G intacto',
  t.mods('B') not like '%credit%' and t.mods('G') = 'campaigns:manual,dashboard:plan,dispatches:plan,einvoicing:plan,pos:plan,products:plan,sales:plan,storefront:plan', t.mods('G'));
reset role;

-- is_custom toggle
insert into public.tenants(name) values ('T');
insert into public.billing_subscriptions(tenant_id, plan_id) select t.tid('T'), id from public.billing_plans where key = 'toggle_n';
select t.chk('4.7 plan normal toggle_n: T recibe dashboard+reports como plan', t.mods('T') = 'dashboard:plan,reports:plan', t.mods('T'));
update public.billing_plans set is_custom = true where key = 'toggle_n';
select t.chk('4.8 plan pasa a is_custom SIN negociacion: sync NO-OP, conserva los modulos gestionados (C3)',
  t.mods('T') = 'dashboard:plan,reports:plan', t.mods('T'));
insert into public.billing_subscription_modules(subscription_id, module_key, price_cents) values (t.sid('T'), 'sales', 0);
select t.chk('4.9 con al menos 1 fila negociada el sync SI reemplaza los modulos gestionados (C3)',
  t.mods('T') = 'sales:subscription', t.mods('T'));
delete from public.billing_subscription_modules where subscription_id = t.sid('T');
select t.chk('4.10 borrar la ultima fila negociada vuelve a ser NO-OP (documentado)',
  t.mods('T') = 'sales:subscription', t.mods('T'));
update public.billing_plans set is_custom = false where key = 'toggle_n';
select t.chk('4.11 plan vuelve a normal: re-sync desde billing_plan_modules', t.mods('T') = 'dashboard:plan,reports:plan', t.mods('T'));

\echo '== 5. Plan custom (Enterprise): modulos desde billing_subscription_modules'
insert into public.tenants(name) values ('C');
insert into public.tenant_enabled_modules(tenant_id, module_key) values (t.tid('C'),'settings');  -- manual
insert into public.billing_subscriptions(tenant_id, plan_id) select t.tid('C'), id from public.billing_plans where key = 'enterprise_n';
do $$
begin
  perform t.chk('5.1 custom sin negociar: total 0 => NO se crea factura, NO se activa, billed_at sigue NULL',
    not exists (select 1 from public.payment_invoices where subscription_id = t.sid('C'))
    and (select status = 'PENDING_PAYMENT' and setup_fee_billed_at is null from public.billing_subscriptions where id = t.sid('C')));
  perform t.chk('5.2 custom sin modulos: solo queda el manual', t.mods('C') = 'settings:manual', t.mods('C'));
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
update public.billing_subscriptions set custom_base_amount_cents = 10000000 where id = t.sid('C');
insert into public.billing_subscription_modules(subscription_id, module_key, price_cents, note) values
  (t.sid('C'), 'sales', 5000000, null), (t.sid('C'), 'pos', 3000000, 'Terminal extra'), (t.sid('C'), 'einvoicing', 2000000, null);
select t.chk('5.3 insertar billing_subscription_modules sincroniza con source=subscription (manual intacto)',
  t.mods('C') = 'einvoicing:subscription,pos:subscription,sales:subscription,settings:manual', t.mods('C'));
do $$
declare v_inv uuid; v_ent jsonb;
begin
  v_inv := public.create_invoice_for_subscription(t.sid('C'));
  raise notice 'items factura custom C: %', t.items(v_inv);
  perform t.chk('5.4 factura custom: monto = base 10.000.000 + modulos 10.000.000 = 20.000.000, PENDING',
    (select amount_cents = 20000000 and status = 'PENDING' from public.payment_invoices where id = v_inv));
  perform t.chk('5.5 factura custom: 1 item base + 3 modulos = 4 items; suman el monto',
    (select count(*) from public.payment_invoice_items where invoice_id = v_inv) = 4
    and (select sum(subtotal_cents) from public.payment_invoice_items where invoice_id = v_inv) = 20000000, t.items(v_inv));
  perform t.chk('5.6 la nota del modulo viaja en el item', t.items(v_inv) like '%Módulo: Punto de venta — Terminal extra=3000000%', t.items(v_inv));
  perform t.chk('5.7 custom con total > 0 NO se activa solo (PENDING_PAYMENT)',
    (select status from public.billing_subscriptions where id = t.sid('C')) = 'PENDING_PAYMENT');
  v_ent := public.get_tenant_entitlements(t.tid('C'));
  raise notice 'entitlements C: %', jsonb_pretty(v_ent);
  perform t.chk('5.8 entitlements: plan custom, limites NULL=ilimitado, precios por modulo, source',
    v_ent #>> '{plan,is_custom}' = 'true' and v_ent #> '{limits,max_users}' = 'null'::jsonb
    and (select (m ->> 'price_cents')::int from jsonb_array_elements(v_ent -> 'modules') m where m ->> 'key' = 'pos') = 3000000
    and (select m ->> 'source' from jsonb_array_elements(v_ent -> 'modules') m where m ->> 'key' = 'pos') = 'subscription'
    and (select m -> 'price_cents' from jsonb_array_elements(v_ent -> 'modules') m where m ->> 'key' = 'settings') = 'null'::jsonb, v_ent::text);
end $$;
update public.payment_invoices set status = 'PAID' where subscription_id = t.sid('C');
select t.chk('5.9 pagada la factura, el trigger existente activa la suscripcion',
  (select status from public.billing_subscriptions where id = t.sid('C')) = 'ACTIVE');
delete from public.billing_subscription_modules where subscription_id = t.sid('C') and module_key = 'einvoicing';
select t.chk('5.10 quitar un modulo contratado lo retira del comercio (manual intacto)',
  t.mods('C') = 'pos:subscription,sales:subscription,settings:manual', t.mods('C'));
reset role;

\echo '== 6. Facturacion: casos de create_invoice_for_subscription / cron'
-- H: custom con override de implementacion
insert into public.tenants(name) values ('H');
insert into public.billing_subscriptions(tenant_id, plan_id, custom_base_amount_cents, setup_fee_override_cents)
  select t.tid('H'), id, 1000000, 50000000 from public.billing_plans where key = 'enterprise_n';
-- K: custom solo implementacion
insert into public.tenants(name) values ('K');
insert into public.billing_subscriptions(tenant_id, plan_id, setup_fee_override_cents)
  select t.tid('K'), id, 3000000 from public.billing_plans where key = 'enterprise_n';
-- N: plan normal sin implementacion; E: plan $0; ZS: $0 con implementacion
insert into public.tenants(name) values ('N'),('E'),('ZS'),('O0'),('O1');
insert into public.billing_subscriptions(tenant_id, plan_id) select t.tid('N'), id from public.billing_plans where key = 'nosetup_n';
insert into public.billing_subscriptions(tenant_id, plan_id) select t.tid('E'), id from public.billing_plans where key = 'zero_n';
insert into public.billing_subscriptions(tenant_id, plan_id) select t.tid('ZS'), id from public.billing_plans where key = 'zero_setup_n';
insert into public.billing_subscriptions(tenant_id, plan_id, setup_fee_override_cents) select t.tid('O0'), id, 0 from public.billing_plans where key = 'starter_n';
insert into public.billing_subscriptions(tenant_id, plan_id, setup_fee_override_cents) select t.tid('O1'), id, 1000 from public.billing_plans where key = 'starter_n';
do $$
declare v_inv uuid;
begin
  select id into v_inv from public.payment_invoices where subscription_id = t.sid('H');
  perform t.chk('6.1 custom con override: 1.000.000 + implementacion 50.000.000 = 51.000.000, items base+implementacion',
    (select amount_cents from public.payment_invoices where id = v_inv) = 51000000
    and (select count(*) from public.payment_invoice_items where invoice_id = v_inv) = 2, t.items(v_inv));
  select id into v_inv from public.payment_invoices where subscription_id = t.sid('K');
  perform t.chk('6.2 custom con base 0 y solo implementacion: 1 item "Implementación" y monto 3.000.000 PENDING',
    (select amount_cents = 3000000 and status = 'PENDING' from public.payment_invoices where id = v_inv)
    and (select count(*) from public.payment_invoice_items where invoice_id = v_inv) = 1, t.items(v_inv));
  select id into v_inv from public.payment_invoices where subscription_id = t.sid('N');
  perform t.chk('6.3 plan sin implementacion: 1 item, monto = plan, billed_at fijado',
    (select amount_cents from public.payment_invoices where id = v_inv) = 5000000
    and (select count(*) from public.payment_invoice_items where invoice_id = v_inv) = 1
    and (select setup_fee_billed_at is not null from public.billing_subscriptions where id = t.sid('N')), t.items(v_inv));
  select id into v_inv from public.payment_invoices where subscription_id = t.sid('E');
  perform t.chk('6.4 plan $0 (no custom): factura PAID de 0 y la suscripcion queda ACTIVE',
    (select amount_cents = 0 and status = 'PAID' from public.payment_invoices where id = v_inv)
    and (select status from public.billing_subscriptions where id = t.sid('E')) = 'ACTIVE');
  select id into v_inv from public.payment_invoices where subscription_id = t.sid('ZS');
  perform t.chk('6.5 plan $0 pero con implementacion: total 500.000 => PENDING, NO se activa',
    (select amount_cents = 500000 and status = 'PENDING' from public.payment_invoices where id = v_inv)
    and (select status from public.billing_subscriptions where id = t.sid('ZS')) = 'PENDING_PAYMENT');
  select id into v_inv from public.payment_invoices where subscription_id = t.sid('O0');
  perform t.chk('6.6 override de implementacion = 0: sin item de implementacion, monto = plan',
    (select amount_cents from public.payment_invoices where id = v_inv) = 6990000
    and (select count(*) from public.payment_invoice_items where invoice_id = v_inv) = 1, t.items(v_inv));
  select id into v_inv from public.payment_invoices where subscription_id = t.sid('O1');
  perform t.chk('6.7 override de implementacion = 1.000: reemplaza al del plan (6.990.000 + 1.000)',
    (select amount_cents from public.payment_invoices where id = v_inv) = 6991000, t.items(v_inv));
end $$;

-- Renovacion por cron: sin implementacion; idempotencia por periodo
insert into public.tenants(name) values ('R');
insert into public.billing_subscriptions(tenant_id, plan_id) select t.tid('R'), id from public.billing_plans where key = 'starter_n';
update public.payment_invoices set status = 'PAID' where subscription_id in (t.sid('R'), t.sid('H'));
update public.billing_subscriptions set current_period_end = now() + interval '1 day' where id in (t.sid('R'), t.sid('H'));
select public.process_recurring_billing_invoices();
do $$
declare v_old uuid; v_new uuid; v_n int; v_billed timestamptz;
begin
  perform t.chk('6.8 cron: R (plan normal) tiene 2 facturas',
    (select count(*) from public.payment_invoices where subscription_id = t.sid('R')) = 2);
  select id into v_new from public.payment_invoices where subscription_id = t.sid('R') order by created_at desc, id limit 1;
  perform t.chk('6.9 renovacion SIN implementacion: monto 6.990.000, 1 item',
    (select count(*) from public.payment_invoice_items where invoice_id = v_new) = 1
    and (select count(*) filter (where amount_cents = 6990000) from public.payment_invoices where subscription_id = t.sid('R')) = 1
    and (select count(*) filter (where amount_cents = 21990000) from public.payment_invoices where subscription_id = t.sid('R')) = 1, t.items(v_new));
  perform t.chk('6.10 cron: H (custom) renueva solo la base (1.000.000), sin implementacion',
    (select count(*) from public.payment_invoices where subscription_id = t.sid('H')) = 2
    and exists (select 1 from public.payment_invoices where subscription_id = t.sid('H') and amount_cents = 1000000 and status = 'PENDING'));
  select count(*) into v_n from public.payment_invoices where subscription_id = t.sid('R');
  perform public.process_recurring_billing_invoices();
  perform t.chk('6.11 idempotencia: segunda corrida del cron no duplica facturas', (select count(*) from public.payment_invoices where subscription_id = t.sid('R')) = v_n);
  perform t.chk('6.12 idempotencia: create_invoice_for_subscription del mismo periodo devuelve NULL',
    public.create_invoice_for_subscription(t.sid('R')) is null);
end $$;

\echo '== 6b. C1 overflow / aislamiento del cron; C2 periodo vencido'
-- C1: BIG = custom con base 2.000.000.000 (la 1a factura cabe); luego se le suma un modulo y el total desborda integer
insert into public.tenants(name) values ('BIG'),('M');
insert into public.billing_subscriptions(tenant_id, plan_id, custom_base_amount_cents)
  select t.tid('BIG'), id, 2000000000 from public.billing_plans where key = 'enterprise_n';
insert into public.billing_subscriptions(tenant_id, plan_id) select t.tid('M'), id from public.billing_plans where key = 'nosetup_n';
update public.payment_invoices set status = 'PAID' where subscription_id in (t.sid('BIG'), t.sid('M'));
insert into public.billing_subscription_modules(subscription_id, module_key, price_cents) values (t.sid('BIG'), 'sales', 500000000);
update public.billing_subscriptions set current_period_end = now() + interval '1 day' where id in (t.sid('BIG'), t.sid('M'));
create table t.big_before as select current_period_start, current_period_end from public.billing_subscriptions where id = t.sid('BIG');
create table t.m_before as select current_period_end from public.billing_subscriptions where id = t.sid('M');
select public.process_recurring_billing_invoices();
do $$
begin
  perform t.expect_error('6b.1 monto > integer: excepcion clara antes de insertar nada',
    format($q$select public.create_invoice_for_subscription(%L)$q$, t.sid('BIG')), '%excede el máximo facturable%');
  perform t.chk('6b.2 cron: la suscripcion normal M se facturo y avanzo de periodo pese a la enorme',
    (select count(*) from public.payment_invoices where subscription_id = t.sid('M')) = 2
    and (select current_period_end from public.billing_subscriptions where id = t.sid('M')) > (select current_period_end from t.m_before));
  perform t.chk('6b.3 cron: la enorme queda intacta (periodo NO avanzado, sin factura nueva)',
    (select count(*) from public.payment_invoices where subscription_id = t.sid('BIG')) = 1
    and (select (bs.current_period_start, bs.current_period_end) = (b.current_period_start, b.current_period_end)
         from public.billing_subscriptions bs, t.big_before b where bs.id = t.sid('BIG')));
end $$;

-- C2: custom negociada tarde con el periodo original ya vencido
insert into public.tenants(name) values ('P'),('Q');
insert into public.billing_subscriptions(tenant_id, plan_id) select t.tid('P'), id from public.billing_plans where key = 'enterprise_n';
insert into public.billing_subscriptions(tenant_id, plan_id) select t.tid('Q'), id from public.billing_plans where key = 'enterprise_n';
update public.billing_subscriptions set current_period_start = now() - interval '3 months', current_period_end = now() - interval '2 months',
  custom_base_amount_cents = 5000000 where id = t.sid('P');
create table t.q_before as select current_period_end from public.billing_subscriptions where id = t.sid('Q');
update public.billing_subscriptions set custom_base_amount_cents = 5000000 where id = t.sid('Q');
do $$
declare v_inv uuid; v_due date;
begin
  v_inv := public.create_invoice_for_subscription(t.sid('P'));
  select due_date into v_due from public.payment_invoices where id = v_inv;
  perform t.chk('6b.4 periodo vencido: la 1a factura nace con due_date futuro (periodo reiniciado)',
    v_due > current_date + 25 and (select current_period_end > now() + interval '27 days' and current_period_start > now() - interval '1 minute'
      from public.billing_subscriptions where id = t.sid('P')), 'due=' || v_due);
  perform public.deactivate_tenants_with_overdue_invoices();
  perform t.chk('6b.5 el cron horario NO desactiva al comercio', (select status from public.tenants where id = t.tid('P')) = 'active');
  perform public.create_invoice_for_subscription(t.sid('Q'));
  perform t.chk('6b.6 periodo vigente NO se reinicia',
    (select current_period_end from public.billing_subscriptions where id = t.sid('Q')) = (select current_period_end from t.q_before));
end $$;

\echo '== 7. Limites (0 = ninguna, NULL = ilimitado)'
insert into public.tenants(name) values ('L0'),('L1'),('LN');
insert into public.billing_subscriptions(tenant_id, plan_id) select t.tid('L0'), id from public.billing_plans where key = 'starter_n';
insert into public.billing_subscriptions(tenant_id, plan_id) select t.tid('L1'), id from public.billing_plans where key = 'business_ai_n';
insert into public.billing_subscriptions(tenant_id, plan_id) select t.tid('LN'), id from public.billing_plans where key = 'enterprise_n';
do $$
declare i int;
begin
  perform t.expect_error('7.1 max_whatsapp_lines=0 impide activar una linea (insert activa)',
    format($q$insert into public.whatsapp_lines(tenant_id, status) values (%L, 'active')$q$, t.tid('L0')), '%no incluye líneas de WhatsApp%');
  insert into public.whatsapp_lines(tenant_id, status) values (t.tid('L0'), 'pending_verification');
  perform t.expect_error('7.2 max_whatsapp_lines=0 impide activar una linea existente (update a active)',
    format($q$update public.whatsapp_lines set status='active' where tenant_id=%L$q$, t.tid('L0')), '%no incluye líneas de WhatsApp%');
  insert into public.whatsapp_lines(tenant_id, status) values (t.tid('L1'), 'active');
  perform t.chk('7.3 max_whatsapp_lines=1: primera linea activa permitida', true);
  perform t.expect_error('7.4 max_whatsapp_lines=1: segunda linea activa rechazada',
    format($q$insert into public.whatsapp_lines(tenant_id, status) values (%L, 'active')$q$, t.tid('L1')), '%máximo de 1 líneas%');
  for i in 1..3 loop insert into public.whatsapp_lines(tenant_id, status) values (t.tid('LN'), 'active'); end loop;
  perform t.chk('7.5 max_whatsapp_lines=NULL (ilimitado): 3 lineas activas permitidas',
    (select count(*) from public.whatsapp_lines where tenant_id = t.tid('LN') and status = 'active') = 3);
  insert into public.whatsapp_lines(tenant_id, status) values ('aaaaaaaa-0000-0000-0000-00000000000a', 'active');
  perform t.expect_error('7.6 legado (max 1) conserva su comportamiento: segunda linea rechazada',
    $q$insert into public.whatsapp_lines(tenant_id, status) values ('aaaaaaaa-0000-0000-0000-00000000000a', 'active')$q$, '%máximo de 1 líneas%');
  -- usuarios
  insert into public.profiles(id, tenant_id, role, active) values (gen_random_uuid(), t.tid('L0'), 'tenant_admin', true), (gen_random_uuid(), t.tid('L0'), 'tenant_agent', true);
  perform t.expect_error('7.7 max_users=2: tercer usuario activo rechazado',
    format($q$insert into public.profiles(id, tenant_id, role, active) values (gen_random_uuid(), %L, 'tenant_agent', true)$q$, t.tid('L0')), '%máximo de 2 usuarios%');
  for i in 1..4 loop insert into public.profiles(id, tenant_id, role, active) values (gen_random_uuid(), t.tid('LN'), 'tenant_agent', true); end loop;
  perform t.chk('7.8 max_users=NULL: 4 usuarios activos permitidos', true);
end $$;

\echo '== 9. Comercio sin suscripcion y suscripcion cancelada'
do $$
declare v_before text; v_r jsonb; v_ent jsonb;
begin
  v_before := t.mods('Legacy D (sin suscripcion)');
  v_r := public.sync_tenant_modules_from_plan(t.tid('Legacy D (sin suscripcion)'));
  perform t.chk('9.1 sin suscripcion: sync no hace nada', t.mods('Legacy D (sin suscripcion)') = v_before and v_r -> 'subscription_id' = 'null'::jsonb
    and v_r -> 'added' = '[]'::jsonb and v_r -> 'removed' = '[]'::jsonb, v_r::text);
  update public.billing_subscriptions set status = 'CANCELLED' where id = t.sid('R');
  v_before := t.mods('R');
  v_r := public.sync_tenant_modules_from_plan(t.tid('R'));
  perform t.chk('9.2 suscripcion CANCELLED: sync no hace nada (no hay vigente), modulos se conservan', t.mods('R') = v_before and v_before <> '', v_before);
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
do $$
begin
  perform t.expect_error('9.4 apply_plan_to_tenant(replace=true) sin suscripcion rechazado',
    format($q$select public.apply_plan_to_tenant(%L, true)$q$, t.tid('Legacy D (sin suscripcion)')), '%no tiene una suscripcion vigente%');
  perform t.chk('9.5 y los modulos del comercio siguen intactos', t.mods('Legacy D (sin suscripcion)') = 'pos:manual,products:manual', t.mods('Legacy D (sin suscripcion)'));
  perform t.chk('9.6 entitlements sin suscripcion: plan/limits nulos, modulos reales',
    (public.get_tenant_entitlements(t.tid('Legacy D (sin suscripcion)')) -> 'limits') = 'null'::jsonb
    and jsonb_array_length(public.get_tenant_entitlements(t.tid('Legacy D (sin suscripcion)')) -> 'modules') = 2);
end $$;
reset role;

\echo '== 10. Permisos'
insert into public.profiles(id, tenant_id, role, active) values ('00000000-0000-0000-0000-0000000000b1', t.tid('B'), 'tenant_admin', true);
insert into public.profiles(id, tenant_id, role, active) values ('00000000-0000-0000-0000-0000000000c1', t.tid('C'), 'tenant_admin', true);
set role anon;
select set_config('request.jwt.claim.sub', '', false);
do $$
begin
  perform t.expect_error('10.1 anon no ejecuta sync_tenant_modules_from_plan', format($q$select public.sync_tenant_modules_from_plan(%L)$q$, t.tid('B')), '%permission denied for function%');
  perform t.expect_error('10.2 anon no ejecuta apply_plan_to_tenant', format($q$select public.apply_plan_to_tenant(%L, false)$q$, t.tid('B')), '%permission denied for function%');
  perform t.expect_error('10.3 anon no ejecuta get_tenant_entitlements', format($q$select public.get_tenant_entitlements(%L)$q$, t.tid('B')), '%permission denied for function%');
  perform t.expect_error('10.4 anon no ejecuta create_invoice_for_subscription', format($q$select public.create_invoice_for_subscription(%L)$q$, t.sid('B')), '%permission denied for function%');
  perform t.expect_error('10.5 anon no lee billing_plan_modules', 'select * from public.billing_plan_modules', '%permission denied%');
  perform t.expect_error('10.6 anon no escribe billing_subscription_modules',
    format($q$insert into public.billing_subscription_modules(subscription_id, module_key) values (%L,'sales')$q$, t.sid('C')), '%permission denied%');
end $$;
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', false);   -- tenant_admin de B (no superadmin)
do $$
declare v_n int;
begin
  perform t.expect_error('10.7 authenticated NO ejecuta sync_tenant_modules_from_plan', format($q$select public.sync_tenant_modules_from_plan(%L)$q$, t.tid('B')), '%permission denied for function%');
  perform t.expect_error('10.8 no superadmin: apply_plan_to_tenant rechazado', format($q$select public.apply_plan_to_tenant(%L, false)$q$, t.tid('B')), '%Solo el superadmin%');
  perform t.expect_error('10.9 no superadmin: preview_apply_plan_to_tenant rechazado', format($q$select public.preview_apply_plan_to_tenant(%L)$q$, t.tid('B')), '%Solo el superadmin%');
  perform t.expect_error('10.10 no superadmin: create_invoice_for_subscription rechazado', format($q$select public.create_invoice_for_subscription(%L)$q$, t.sid('B')), '%Solo el superadmin%');
  perform t.expect_error('10.11 tenant no escribe billing_plan_modules (RLS)',
    $q$insert into public.billing_plan_modules(plan_id, module_key) select id,'reports' from public.billing_plans where key='starter_n'$q$, '%row-level security%');
  perform t.expect_error('10.12 tenant no escribe billing_subscription_modules (RLS)',
    format($q$insert into public.billing_subscription_modules(subscription_id, module_key) values (%L,'reports')$q$, t.sid('B')), '%row-level security%');
  update public.tenant_enabled_modules set source = 'manual' where tenant_id = t.tid('B');
  get diagnostics v_n = row_count;
  perform t.chk('10.13 tenant no puede cambiar source en tenant_enabled_modules (0 filas por RLS)', v_n = 0, 'filas=' || v_n);
  delete from public.tenant_enabled_modules where tenant_id = t.tid('B');
  get diagnostics v_n = row_count;
  perform t.chk('10.14 tenant no puede borrar sus modulos (0 filas por RLS)', v_n = 0, 'filas=' || v_n);
  perform t.chk('10.15 tenant lee SUS entitlements', (public.get_tenant_entitlements(t.tid('B')) #>> '{plan,key}') = 'business_n');
  perform t.expect_error('10.16 tenant NO lee entitlements de otro comercio', format($q$select public.get_tenant_entitlements(%L)$q$, t.tid('C')), '%No autorizado%');
  select count(*) into v_n from public.billing_subscription_modules;
  perform t.chk('10.17 tenant B no ve lo negociado por otros (RLS)', v_n = 0, 'filas=' || v_n);
  select count(*) into v_n from public.billing_plan_modules;
  perform t.chk('10.18 tenant si lee el catalogo de modulos de los planes', v_n > 0);
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);   -- tenant C: ve lo suyo
select t.chk('10.19 tenant C ve sus 2 modulos negociados', (select count(*) from public.billing_subscription_modules) = 2);
reset role;

-- foto para la prueba de re-ejecucion
create table t.snap_final as select tenant_id, module_key, source from public.tenant_enabled_modules;
create table t.snap_billed as select id, setup_fee_billed_at from public.billing_subscriptions;
create table t.snap_inv as select id, amount_cents, status from public.payment_invoices;
