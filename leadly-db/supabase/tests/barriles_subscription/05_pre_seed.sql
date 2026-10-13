-- Estado "produccion" ANTES de 20261013150000/160000: 3 planes de prueba, TecnoNova
-- con 2 suscripciones ACTIVE, 0 facturas. (Mismo punto de partida que delete_test_plans.)
set client_min_messages = warning;
insert into public.profiles(id, tenant_id, role) values ('00000000-0000-0000-0000-0000000000a1', null, 'superadmin');
insert into public.billing_plans(id, key, name, description, amount_cents, billing_interval, max_users, max_whatsapp_lines) values
 ('8c4ba4cb-1403-4104-9e7d-4483d3c53055','Starter','Plan Starter','Plan de prueba',19900000,'monthly',3,1),
 ('ede48a7c-20bb-4591-977d-03162b40661e','GROWTH','Plan Growth','Plan de prueba',49900000,'monthly',5,2),
 ('55a586d4-ce28-44f9-85c0-327d7717972a','SCALE','Plan Scale','Plan de prueba',89900000,'monthly',10,null);
insert into public.tenants(id, name) values ('cb195047-8cd2-4e38-9964-62bb99911814','TecnoNova');
insert into public.billing_subscriptions(id, tenant_id, plan_id, status) values
 ('f9951979-a47c-4bd6-a9e3-543c6cd4242a','cb195047-8cd2-4e38-9964-62bb99911814','8c4ba4cb-1403-4104-9e7d-4483d3c53055','ACTIVE'),
 ('e9146063-95f7-4dbd-8b5f-ad176dce68ed','cb195047-8cd2-4e38-9964-62bb99911814','8c4ba4cb-1403-4104-9e7d-4483d3c53055','ACTIVE');
delete from public.payment_invoices;
set client_min_messages = notice;
