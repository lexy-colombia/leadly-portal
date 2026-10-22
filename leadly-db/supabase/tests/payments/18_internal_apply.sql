-- ST3: apply_wompi_order_payment / apply_wompi_invoice_payment sobre el esquema
-- public REAL simulado (40_legacy_stubs.sql + migracion 20261016130000).
-- Se ejecuta DESPUES de las pruebas de concurrencia (run.sh carga los stubs antes).
\set ON_ERROR_STOP 1
reset role;
insert into public.tenants(id, name) values
  ('a0000000-0000-4000-8000-000000000001', 'T1'), ('a0000000-0000-4000-8000-000000000002', 'T2');
insert into public.sales_orders(id, tenant_id, number, status, total) values
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 1, 'confirmada', 1500.00),
  ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 2, 'confirmada', 1500.00),
  ('b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 3, 'cotizacion', 1500.00),
  ('b0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 4, 'cancelada', 1500.00),
  ('b0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000002', 5, 'confirmada', 1500.00),
  ('b0000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000001', 6, 'confirmada', 3000.00);
insert into public.sales_orders(id, tenant_id, number, status, total, deleted_at) values
  ('b0000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000001', 7, 'confirmada', 1500.00, now());

set role service_role;

create temp table r(k text primary key, v jsonb);
grant all on r to service_role;

-- sin FK sobre payment_link_id (el id del link del servicio no vive en public)
reset role;
select t.ok((select count(*) from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
              where c.conrelid = 'public.sales_order_payments'::regclass and c.contype = 'f' and a.attname = 'payment_link_id') = 0,
            'sin FK sobre sales_order_payments.payment_link_id');
select t.ok(to_regclass('public.sales_order_payments_payment_link_idx') is not null, 'indice unico por link conservado');
set role service_role;

-- 1. aplica
insert into r select 'a1', public.apply_wompi_order_payment('b0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001','tx-1',150000,150000,'COP','VISA ****4242');
select t.ok((select v->>'result' from r where k='a1') = 'applied', 'pedido: applied');
select t.ok((select count(*) from public.sales_order_payments where order_id='b0000000-0000-4000-8000-000000000001'
              and method='wompi' and amount=1500.00 and provider_key='wompi' and provider_transaction_id='tx-1'
              and provider_reference='VISA ****4242' and payment_link_id='c0000000-0000-4000-8000-000000000001'
              and tenant_id='a0000000-0000-4000-8000-000000000001' and currency='COP') = 1, 'fila con todos los campos del pago');
-- 2. reentrega
insert into r select 'a2', public.apply_wompi_order_payment('b0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001','tx-1',150000,150000,'COP','VISA ****4242');
select t.ok((select v->>'result' from r where k='a2') = 'duplicate'
        and (select count(*) from public.sales_order_payments where order_id='b0000000-0000-4000-8000-000000000001') = 1, 'reentrega del mismo evento: duplicate, 1 sola fila');
-- 3. mismo link, otra transaccion
select t.ok((public.apply_wompi_order_payment('b0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001','tx-OTRA',150000,150000,'COP')->>'reason') = 'link_already_credited_with_other_transaction', 'mismo link con otra transaccion: conflict (no duplicate)');
-- 4. misma transaccion en OTRO pedido/link
insert into r select 'a4', public.apply_wompi_order_payment('b0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000002','tx-1',150000,150000,'COP');
select t.ok((select v->>'result' from r where k='a4') = 'conflict' and (select v->>'reason' from r where k='a4') = 'transaction_already_applied'
        and (select count(*) from public.sales_order_payments where order_id='b0000000-0000-4000-8000-000000000002') = 0, 'misma transaccion en otro pedido: conflict, sin acreditar');
-- 5. tenant ajeno
insert into r select 'a5', public.apply_wompi_order_payment('b0000000-0000-4000-8000-000000000005','a0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000005','tx-5',150000,150000,'COP');
select t.ok((select v->>'reason' from r where k='a5') = 'tenant_mismatch' and (select v->>'result' from r where k='a5') = 'not_applicable'
        and (select count(*) from public.sales_order_payments where order_id='b0000000-0000-4000-8000-000000000005') = 0, 'pedido de OTRO tenant: no acredita');
-- 6. montos
select t.ok((public.apply_wompi_order_payment('b0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000002','tx-6',149999,150000,'COP')->>'reason') = 'amount_mismatch', 'monto del evento distinto del link');
select t.ok((public.apply_wompi_order_payment('b0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000002','tx-6',150000,150000,'USD')->>'reason') = 'amount_mismatch', 'moneda distinta de la del pedido');
-- 7. estado del pedido
select t.ok((public.apply_wompi_order_payment('b0000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000003','tx-7a',150000,150000,'COP')->>'reason') = 'order_closed', 'cotizacion: no acredita');
select t.ok((public.apply_wompi_order_payment('b0000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000004','tx-7b',150000,150000,'COP')->>'reason') = 'order_closed', 'cancelada: no acredita');
select t.ok((public.apply_wompi_order_payment('b0000000-0000-4000-8000-000000000007','a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000007','tx-7c',150000,150000,'COP')->>'reason') = 'order_closed', 'borrado: no acredita');
select t.ok((public.apply_wompi_order_payment('b0000000-0000-4000-8000-0000000000ff','a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-0000000000ff','tx-7d',150000,150000,'COP')->>'reason') = 'order_not_found', 'pedido inexistente');
-- 8. pedido ya pagado por completo: segundo cobro real (otro link/otra tx) no se acredita
insert into r select 'a8', public.apply_wompi_order_payment('b0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000009','tx-9',150000,150000,'COP');
select t.ok((select v->>'result' from r where k='a8') = 'conflict' and (select v->>'reason' from r where k='a8') = 'order_already_paid'
        and (select count(*) from public.sales_order_payments where order_id='b0000000-0000-4000-8000-000000000001') = 1, 'segundo pago aprobado sobre pedido ya pagado: no doble acreditacion');
-- 9. pago parcial en dos cobros
select t.ok((public.apply_wompi_order_payment('b0000000-0000-4000-8000-000000000006','a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000011','tx-11',150000,150000,'COP')->>'result') = 'applied', 'parcial 1/2');
select t.ok((public.apply_wompi_order_payment('b0000000-0000-4000-8000-000000000006','a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000012','tx-12',150000,150000,'COP')->>'result') = 'applied', 'parcial 2/2 (saldo restante)');
-- 10. transaccion usada por una factura
reset role;
insert into public.payment_invoices(id, payer_tenant_id, provider_key, amount_cents, status, provider_transaction_id)
  values ('d0000000-0000-4000-8000-000000000009', 'a0000000-0000-4000-8000-000000000001', 'manual', 1000, 'PAID', 'tx-fact');
set role service_role;
select t.ok((public.apply_wompi_order_payment('b0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000020','tx-fact',150000,150000,'COP')->>'reason') = 'transaction_already_applied', 'transaccion ya usada por una factura: conflict');
-- 11. pago borrado (soft-delete) del link
reset role;
update public.sales_order_payments set deleted_at = now() where payment_link_id = 'c0000000-0000-4000-8000-000000000011';
set role service_role;
select t.ok((public.apply_wompi_order_payment('b0000000-0000-4000-8000-000000000006','a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000011','tx-11',150000,150000,'COP')->>'reason') = 'previous_payment_deleted', 'pago borrado: conflict visible, no se re-acredita en silencio');
-- 12. entradas invalidas
select t.ok((public.apply_wompi_order_payment(null,'a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000021','tx',1,1,'COP')->>'reason') = 'invalid_input', 'entrada nula');
select t.ok((public.apply_wompi_order_payment('b0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000021','',150000,150000,'COP')->>'reason') = 'invalid_input', 'transaccion vacia');

-- ===================== facturas de plataforma =====================
reset role;
insert into public.billing_subscriptions(id, status) values ('e0000000-0000-4000-8000-000000000001', 'PENDING');
insert into public.payment_invoices(id, payer_tenant_id, subscription_id, provider_key, amount_cents, status) values
  ('d0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'wompi', 5000000, 'PENDING'),
  ('d0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', null, 'wompi', 5000000, 'OVERDUE'),
  ('d0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', null, 'wompi', 5000000, 'CANCELLED'),
  ('d0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000002', null, 'wompi', 5000000, 'PENDING'),
  ('d0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001', null, 'manual', 5000000, 'PAID');
set role service_role;

insert into r select 'i1', public.apply_wompi_invoice_payment('d0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','tx-i1',5000000,5000000,'COP',
  '{"method":"CARD","brand":"VISA","last_four":"4242","bank":null,"reference":"VISA ****4242","raw":{"id":"tx-i1"}}');
select t.ok((select v->>'result' from r where k='i1') = 'applied', 'factura: applied');
reset role;
select t.ok((select status = 'PAID' and provider_transaction_id = 'tx-i1' and provider_payment_method = 'CARD' and provider_payment_data->>'id' = 'tx-i1'
              from public.payment_invoices where id = 'd0000000-0000-4000-8000-000000000001'), 'factura PAID con datos de la transaccion');
select t.ok((select count(*) from public.payment_attempts where invoice_id = 'd0000000-0000-4000-8000-000000000001'
              and status = 'APPROVED' and provider_key = 'wompi' and amount_cents = 5000000 and payment_brand = 'VISA' and payment_last_four = '4242') = 1, 'un intento APPROVED registrado');
select t.ok((select status from public.billing_subscriptions where id = 'e0000000-0000-4000-8000-000000000001') = 'ACTIVE', 'el trigger activo la suscripcion (misma semantica que hoy)');
set role service_role;
select t.ok((public.apply_wompi_invoice_payment('d0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','tx-i1',5000000,5000000,'COP')->>'result') = 'duplicate', 'factura: reentrega -> duplicate');
reset role;
select t.ok((select count(*) from public.payment_attempts where invoice_id = 'd0000000-0000-4000-8000-000000000001') = 1, 'reentrega no duplica el intento');
set role service_role;
select t.ok((public.apply_wompi_invoice_payment('d0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','tx-i2',5000000,5000000,'COP')->>'reason') = 'invoice_already_paid', 'factura PAID con OTRA transaccion: conflict');
select t.ok((public.apply_wompi_invoice_payment('d0000000-0000-4000-8000-000000000005','a0000000-0000-4000-8000-000000000001','tx-i3',5000000,5000000,'COP')->>'reason') = 'invoice_already_paid', 'factura pagada a mano: conflict (reembolso)');
select t.ok((public.apply_wompi_invoice_payment('d0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','tx-i4',5000000,5000000,'COP')->>'result') = 'applied', 'OVERDUE tambien se paga');
select t.ok((public.apply_wompi_invoice_payment('d0000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001','tx-i5',5000000,5000000,'COP')->>'reason') = 'invoice_closed', 'CANCELLED: no se paga');
select t.ok((public.apply_wompi_invoice_payment('d0000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-000000000001','tx-i6',5000000,5000000,'COP')->>'reason') = 'tenant_mismatch', 'factura de OTRO tenant: no se paga');
select t.ok((public.apply_wompi_invoice_payment('d0000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-000000000002','tx-i7',4999999,4999999,'COP')->>'reason') = 'amount_mismatch', 'monto distinto del de la factura');
select t.ok((public.apply_wompi_invoice_payment('d0000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-000000000002','tx-i7',5000000,4999999,'COP')->>'reason') = 'amount_mismatch', 'monto del evento distinto del link');
select t.ok((public.apply_wompi_invoice_payment('d0000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-000000000002','tx-1',5000000,5000000,'COP')->>'reason') = 'transaction_already_applied', 'transaccion ya acreditada a un pedido: conflict');
select t.ok((public.apply_wompi_invoice_payment('d0000000-0000-4000-8000-0000000000ff','a0000000-0000-4000-8000-000000000002','tx-i8',5000000,5000000,'COP')->>'reason') = 'invoice_not_found', 'factura inexistente');
reset role;
select t.ok((select status from public.payment_invoices where id = 'd0000000-0000-4000-8000-000000000004') = 'PENDING', 'las facturas rechazadas siguen PENDING');

-- ===================== privilegios =====================
select t.denied($$select public.apply_wompi_order_payment('b0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001','tx',1,1,'COP')$$, 'authenticated no ejecuta apply_wompi_order_payment', 'authenticated');
select t.denied($$select public.apply_wompi_order_payment('b0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001','tx',1,1,'COP')$$, 'anon no ejecuta apply_wompi_order_payment', 'anon');
select t.denied($$select public.apply_wompi_invoice_payment('d0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','tx',1,1,'COP')$$, 'authenticated no ejecuta apply_wompi_invoice_payment', 'authenticated');
select t.denied($$select public.apply_wompi_invoice_payment('d0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','tx',1,1,'COP')$$, 'anon no ejecuta apply_wompi_invoice_payment', 'anon');
select t.ok((select bool_and(prosecdef and proconfig = array['search_path=""']) from pg_proc where proname in ('apply_wompi_order_payment','apply_wompi_invoice_payment') and pronamespace = 'public'::regnamespace),
  'security definer con search_path vacio');

-- ===================== guarda del cliente interno (B1) =====================
reset role;
insert into payments.clients(id, name, status, api_key_hash, key_prefix, signing_secret_name, kind, revoked_at) values
  ('f0000000-0000-4000-8000-000000000001','g-int-ok','active',repeat('1',64),'p1','payments/g/1','internal',null),
  ('f0000000-0000-4000-8000-000000000002','g-ext','active',repeat('2',64),'p2','payments/g/2','external',null),
  ('f0000000-0000-4000-8000-000000000003','g-susp','suspended',repeat('3',64),'p3','payments/g/3','internal',null),
  ('f0000000-0000-4000-8000-000000000004','g-rev','active',repeat('4',64),'p4','payments/g/4','internal',now()),
  ('f0000000-0000-4000-8000-000000000005','g-nosecret','active',repeat('5',64),'p5',null,'internal',null);
set role service_role;
select t.ok(public.payments_internal_client_ok('f0000000-0000-4000-8000-000000000001') is true, 'cliente interno activo: ok');
select t.ok(public.payments_internal_client_ok('f0000000-0000-4000-8000-000000000002') is false, 'cliente external: rechazado');
select t.ok(public.payments_internal_client_ok('f0000000-0000-4000-8000-000000000003') is false, 'cliente suspendido: rechazado');
select t.ok(public.payments_internal_client_ok('f0000000-0000-4000-8000-000000000004') is false, 'cliente revocado: rechazado');
select t.ok(public.payments_internal_client_ok('f0000000-0000-4000-8000-000000000005') is false, 'cliente sin secreto: rechazado');
select t.ok(public.payments_internal_client_ok('f0000000-0000-4000-8000-0000000000aa') is false, 'cliente inexistente: false');
select t.ok(public.payments_internal_client_ok(null) is false, 'null: false');
reset role;
select t.denied($$select public.payments_internal_client_ok('f0000000-0000-4000-8000-000000000001')$$, 'authenticated no ejecuta payments_internal_client_ok', 'authenticated');
select t.denied($$select public.payments_internal_client_ok('f0000000-0000-4000-8000-000000000001')$$, 'anon no ejecuta payments_internal_client_ok', 'anon');
