-- D1: backfill sobre la FORMA REAL de produccion (3 comprobantes), indice e idempotencia de esquema.
set client_min_messages = warning;
select t.chk('B1 Barriles PENDING (5851bd75): periodo [2026-10-10, 2026-11-10], due_date intacto 2026-11-10',
  exists (select 1 from public.payment_invoices where id = '5851bd75-6fd7-4ae8-bae6-f2ec705e9010'
          and period_start = '2026-10-10' and period_end = '2026-11-10' and due_date = '2026-11-10' and status = 'PENDING'));
select t.chk('B2 Barriles PAID: periodo [2026-09-10, 2026-10-10]',
  exists (select 1 from public.payment_invoices where subscription_id = 'b0b0b0b0-0000-4000-8000-000000000001'
          and status = 'PAID' and period_start = '2026-09-10' and period_end = '2026-10-10'));
select t.chk('B3 Faiver PAID: periodo [2026-10-05, 2026-11-05]',
  exists (select 1 from public.payment_invoices where subscription_id = 'fa1fa1fa-0000-4000-8000-000000000001'
          and status = 'PAID' and period_start = '2026-10-05' and period_end = '2026-11-05'));
select t.chk('B4 las 3 facturas reales tienen periodo y no hay mas facturas',
  (select count(*) = 3 and count(*) filter (where period_start is not null and period_end is not null) = 3 from public.payment_invoices));
select t.chk('B5 indice unico parcial (subscription_id, period_start) donde deleted_at is null',
  exists (select 1 from pg_indexes where indexname = 'payment_invoices_subscription_period_uidx'
          and indexdef ilike '%unique%' and indexdef ilike '%(subscription_id, period_start)%' and indexdef ilike '%deleted_at is null%'));
select t.run_as('B6 el indice rechaza un duplicado (misma suscripcion y period_start)', null, null,
  $q$insert into public.payment_invoices(payer_tenant_id, subscription_id, provider_key, amount_cents, status, due_date, period_start, period_end)
     values (t.id('FAI'), 'fa1fa1fa-0000-4000-8000-000000000001', 'wompi', 1, 'PENDING', '2026-11-05', '2026-10-05', '2026-11-05')$q$,
  false, '%payment_invoices_subscription_period_uidx%');
select t.chk('B7 firma de 1 argumento eliminada; solo existe (uuid, date)',
  to_regprocedure('public.create_invoice_for_subscription(uuid)') is null
  and to_regprocedure('public.create_invoice_for_subscription(uuid,date)') is not null
  and (select count(*) from pg_proc where proname = 'create_invoice_for_subscription') = 1);
select t.chk('B8 CHECK de orden de periodo existe',
  exists (select 1 from pg_constraint where conname = 'payment_invoices_period_order_check'));
