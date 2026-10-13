-- Estado "vivo" PREVIO a la migracion: los 3 planes de prueba y comercios con
-- modulos 100% manuales (hoy toda fila de tenant_enabled_modules lo es).
set client_min_messages = warning;
insert into public.profiles(id, tenant_id, role) values ('00000000-0000-0000-0000-0000000000a1', null, 'superadmin');

insert into public.billing_plans(id, key, name, amount_cents, billing_interval, max_users, max_whatsapp_lines) values
 ('11111111-0000-0000-0000-000000000001','starter','Starter',19900000,'monthly',null,1),
 ('11111111-0000-0000-0000-000000000002','growth','Growth',39900000,'monthly',10,3),
 ('11111111-0000-0000-0000-000000000003','scale','Scale',79900000,'monthly',null,null);

insert into public.tenants(id, name) values
 ('aaaaaaaa-0000-0000-0000-00000000000a','Legacy A (TecnoNova-like)'),
 ('aaaaaaaa-0000-0000-0000-00000000000d','Legacy D (sin suscripcion)'),
 ('aaaaaaaa-0000-0000-0000-00000000000f','Legacy F (Growth pendiente)');

insert into public.billing_subscriptions(id, tenant_id, plan_id, status) values
 ('bbbbbbbb-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-00000000000a','11111111-0000-0000-0000-000000000001','ACTIVE'),
 ('bbbbbbbb-0000-0000-0000-00000000000f','aaaaaaaa-0000-0000-0000-00000000000f','11111111-0000-0000-0000-000000000002','PENDING_PAYMENT');

insert into public.tenant_enabled_modules(tenant_id, module_key) values
 ('aaaaaaaa-0000-0000-0000-00000000000a','dashboard'),
 ('aaaaaaaa-0000-0000-0000-00000000000a','sales'),
 ('aaaaaaaa-0000-0000-0000-00000000000a','conversations'),
 ('aaaaaaaa-0000-0000-0000-00000000000a','campaigns'),
 ('aaaaaaaa-0000-0000-0000-00000000000a','pos'),
 ('aaaaaaaa-0000-0000-0000-00000000000d','products'),
 ('aaaaaaaa-0000-0000-0000-00000000000d','pos'),
 ('aaaaaaaa-0000-0000-0000-00000000000f','contacts');

-- Foto previa a la migracion
create table t.snap_before as
  select tenant_id, module_key from public.tenant_enabled_modules;
create table t.snap_invoices_before as
  select id, subscription_id, amount_cents, status from public.payment_invoices;
