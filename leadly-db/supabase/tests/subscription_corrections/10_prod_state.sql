-- Estado de produccion (2026-10-13) DESPUES de 20261013160000, ANTES de 165000/170000/180000.
-- Se crea con los mecanismos reales (triggers y funciones vigentes) y luego se fijan
-- a mano los valores observados en produccion.
set client_min_messages = warning;
-- Barriles: Business PENDING_PAYMENT con su unica factura (14000000 + 35000000).
insert into public.billing_subscriptions(id, tenant_id, plan_id, status, current_period_start, current_period_end)
select '40e2450d-c79c-4c22-bbf2-cff6f57361c3', '9c79437d-1c19-4edc-bc1f-0dc06094823a', p.id, 'PENDING_PAYMENT',
       '2026-10-13 04:40:33+00', '2026-11-13 04:40:33+00'
from public.billing_plans p where p.key = 'business';
update public.billing_subscriptions set created_at = '2026-10-13 04:40:33+00'
 where id = '40e2450d-c79c-4c22-bbf2-cff6f57361c3';
update public.payment_invoices set due_date = '2026-11-13', invoice_number = 'INV-20261013-dc88ce', created_at = '2026-10-13 04:41:00+00'
 where subscription_id = '40e2450d-c79c-4c22-bbf2-cff6f57361c3';

-- Moyano: Enterprise ACTIVE adelantada, factura PAID de 40000000 con 1 intento manual.
insert into public.tenants(id, name, legal_name, document_type, document_number, contact_email, country, status) values
 ('7419c825-4d72-45af-bf40-73375eed9f9c','Faiver Andres','Moyano Samudio','CC','80111222','moyano@example.com','CO','active');
insert into public.billing_subscriptions(id, tenant_id, plan_id, status, custom_base_amount_cents, setup_fee_override_cents)
select '5a79e4bb-3ede-4b83-8966-014ec0b4aa15', '7419c825-4d72-45af-bf40-73375eed9f9c', p.id, 'PENDING_PAYMENT',
       20000000, 20000000
from public.billing_plans p where p.key = 'enterprise';
insert into public.billing_subscription_modules(subscription_id, module_key, price_cents, note)
select '5a79e4bb-3ede-4b83-8966-014ec0b4aa15', k, 0, 'Incluido'
from unnest(array['dashboard','products','inventory','sales','pos','contacts','credit','expenses','returns',
                  'reports','settings','billing','dispatches','einvoicing','integrations']::text[]) k;
-- Fija el id real de la factura de Moyano (copia la fila con el id de produccion y mueve sus items).
insert into public.payment_invoices
select (jsonb_populate_record(null::public.payment_invoices,
         to_jsonb(i) || '{"id":"b596941e-798b-4e77-97ed-00ea681c56a0"}'::jsonb)).*
from public.payment_invoices i where i.subscription_id = '5a79e4bb-3ede-4b83-8966-014ec0b4aa15';
update public.payment_invoice_items set invoice_id = 'b596941e-798b-4e77-97ed-00ea681c56a0'
 where invoice_id in (select id from public.payment_invoices
                       where subscription_id = '5a79e4bb-3ede-4b83-8966-014ec0b4aa15'
                         and id <> 'b596941e-798b-4e77-97ed-00ea681c56a0');
delete from public.payment_invoices
 where subscription_id = '5a79e4bb-3ede-4b83-8966-014ec0b4aa15' and id <> 'b596941e-798b-4e77-97ed-00ea681c56a0';
insert into public.payment_attempts(invoice_id, provider_key, provider_transaction_id, status, amount_cents, currency,
                                     payment_method, payment_reference, raw_data)
select i.id, 'manual', null, 'APPROVED', 40000000, 'COP', 'transferencia', null,
       jsonb_build_object('note','pago manual','recorded_by',null)
from public.payment_invoices i where i.subscription_id = '5a79e4bb-3ede-4b83-8966-014ec0b4aa15';
update public.payment_invoices set status = 'PAID', provider_payment_method = 'transferencia'
 where subscription_id = '5a79e4bb-3ede-4b83-8966-014ec0b4aa15';   -- el trigger vigente (doble avance) mueve el periodo
-- Valores observados en produccion.
update public.billing_subscriptions
   set current_period_start = '2026-11-13 04:34:08+00', current_period_end = '2026-12-13 04:34:08+00',
       created_at = '2026-10-13 04:34:08+00', setup_fee_billed_at = '2026-10-13 04:34:08+00', status = 'ACTIVE'
 where id = '5a79e4bb-3ede-4b83-8966-014ec0b4aa15';
update public.payment_invoices
   set due_date = '2026-11-13', created_at = '2026-10-13 04:35:04+00', invoice_number = 'INV-20261013-00a5f0'
 where subscription_id = '5a79e4bb-3ede-4b83-8966-014ec0b4aa15';
update public.payment_attempts set created_at = '2026-10-13 04:35:30+00'
 where invoice_id in (select id from public.payment_invoices where subscription_id = '5a79e4bb-3ede-4b83-8966-014ec0b4aa15');
set client_min_messages = notice;
