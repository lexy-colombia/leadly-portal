set client_min_messages = warning;
drop schema public cascade; create schema public;
create table tenants(id uuid primary key);
insert into tenants values ('cb195047-8cd2-4e38-9964-62bb99911814'),('22222222-2222-2222-2222-222222222222');
create table payment_providers(key text primary key);
insert into payment_providers values ('wompi'),('manual');
create table payment_invoices(
  id uuid primary key default gen_random_uuid(),
  payer_tenant_id uuid references tenants(id) on delete cascade,
  amount_cents integer not null check (amount_cents >= 0),
  status text not null,
  provider_checkout_id text,
  provider_transaction_id text);
create table payment_invoice_items(
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references payment_invoices(id) on delete cascade,
  description text not null);
create table payment_attempts(
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references payment_invoices(id) on delete cascade,
  provider_key text not null references payment_providers(key),
  provider_transaction_id text, status text not null);
create table billing_subscriptions(id uuid primary key, tenant_id uuid, status text, current_period_end timestamptz);
create table sales_invoices(id uuid primary key default gen_random_uuid(), status text);
-- las 5 facturas falsas
insert into payment_invoices(id,payer_tenant_id,amount_cents,status) values
 ('c22b2fca-6ebf-47cb-bfdf-646494519626','cb195047-8cd2-4e38-9964-62bb99911814',19900000,'PAID'),
 ('9334c37a-e043-474b-815c-3e3aefd99096','cb195047-8cd2-4e38-9964-62bb99911814',19900000,'PAID'),
 ('b958f0fd-ad57-4f82-b03b-b3ba6098f3d0','cb195047-8cd2-4e38-9964-62bb99911814',19900000,'OVERDUE'),
 ('10a84093-dba1-4e41-ac5f-e624d051c368','cb195047-8cd2-4e38-9964-62bb99911814',19900000,'PENDING'),
 ('b4bb8fdd-9b70-4913-bc23-48fabcd0e5b9','cb195047-8cd2-4e38-9964-62bb99911814',19900000,'PENDING');
-- una sexta de OTRO tenant: debe sobrevivir
insert into payment_invoices(id,payer_tenant_id,amount_cents,status,provider_transaction_id) values
 ('66666666-6666-6666-6666-666666666666','22222222-2222-2222-2222-222222222222',5000000,'PAID','real-tx-1');
insert into payment_invoice_items(invoice_id,description) select id,'Plan Starter' from payment_invoices;
insert into payment_attempts(invoice_id,provider_key,status) values
 ('c22b2fca-6ebf-47cb-bfdf-646494519626','manual','APPROVED'),
 ('9334c37a-e043-474b-815c-3e3aefd99096','manual','APPROVED'),
 ('66666666-6666-6666-6666-666666666666','wompi','APPROVED');
insert into billing_subscriptions values
 ('e9146063-95f7-4dbd-8b5f-ad176dce68ed','cb195047-8cd2-4e38-9964-62bb99911814','ACTIVE',now()),
 ('f9951979-a47c-4bd6-a9e3-543c6cd4242a','cb195047-8cd2-4e38-9964-62bb99911814','ACTIVE',now());
insert into sales_invoices(status) values ('accepted'),('pending');
