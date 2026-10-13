-- Estado "produccion" previo a la migracion de planes reales: 3 planes de prueba
-- con las keys EXACTAS de produccion (Starter / GROWTH / SCALE), 2 suscripciones
-- ACTIVE de TecnoNova al plan Starter y modulos 100% manuales.
set client_min_messages = warning;
insert into public.profiles(id, tenant_id, role) values ('00000000-0000-0000-0000-0000000000a1', null, 'superadmin');

insert into public.billing_plans(id, key, name, description, amount_cents, billing_interval, max_users, max_whatsapp_lines) values
 ('11111111-0000-0000-0000-000000000001','Starter','Plan Starter','Plan de prueba',19900000,'monthly',3,1),
 ('11111111-0000-0000-0000-000000000002','GROWTH','Plan Growth','Plan de prueba',49900000,'monthly',10,3),
 ('11111111-0000-0000-0000-000000000003','SCALE','Plan Scale','Plan de prueba',89900000,'monthly',null,null);
update public.billing_plans set max_warehouses = 2, max_pos_points = 1, setup_fee_cents = 100 where key = 'GROWTH';

insert into public.tenants(id, name) values
 ('aaaaaaaa-0000-0000-0000-00000000000a','TecnoNova A'),
 ('aaaaaaaa-0000-0000-0000-00000000000b','TecnoNova B'),
 ('aaaaaaaa-0000-0000-0000-00000000000c','Barriles (sin suscripcion)');

insert into public.billing_subscriptions(id, tenant_id, plan_id, status) values
 ('bbbbbbbb-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-00000000000a','11111111-0000-0000-0000-000000000001','ACTIVE'),
 ('bbbbbbbb-0000-0000-0000-00000000000b','aaaaaaaa-0000-0000-0000-00000000000b','11111111-0000-0000-0000-000000000001','ACTIVE');

insert into public.tenant_enabled_modules(tenant_id, module_key) values
 ('aaaaaaaa-0000-0000-0000-00000000000a','dashboard'),
 ('aaaaaaaa-0000-0000-0000-00000000000a','sales'),
 ('aaaaaaaa-0000-0000-0000-00000000000a','pos'),
 ('aaaaaaaa-0000-0000-0000-00000000000a','conversations'),
 ('aaaaaaaa-0000-0000-0000-00000000000b','dashboard'),
 ('aaaaaaaa-0000-0000-0000-00000000000c','products');

-- Huellas previas a la migracion
create table t.fp_before as
select 'tem' as k, count(*) as n, md5(coalesce(string_agg(m::text, '|' order by m.tenant_id, m.module_key), '')) as h
  from public.tenant_enabled_modules m
union all
select 'subs', count(*), md5(coalesce(string_agg(s::text, '|' order by s.id), ''))
  from public.billing_subscriptions s
union all
select 'inv', count(*), md5(coalesce(string_agg(i::text, '|' order by i.id), ''))
  from public.payment_invoices i
union all
select 'items', count(*), md5(coalesce(string_agg(i::text, '|' order by i.id), ''))
  from public.payment_invoice_items i
union all
select 'test_plans', count(*), md5(coalesce(string_agg(
    (id, amount_cents, currency, billing_interval, max_users, max_whatsapp_lines, setup_fee_cents,
     is_custom, max_warehouses, max_pos_points, max_ai_agents, max_ai_messages_month, sort_order)::text,
    '|' order by id), ''))
  from public.billing_plans;
set client_min_messages = notice;
