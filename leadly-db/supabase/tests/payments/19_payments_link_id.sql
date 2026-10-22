-- ST4: payment_invoices.payments_link_id (migracion 20261016140000) sobre el esquema
-- public simulado (40_legacy_stubs.sql). Aditiva.
\set ON_ERROR_STOP 1
reset role;
select t.ok((select data_type from information_schema.columns where table_schema='public' and table_name='payment_invoices' and column_name='payments_link_id') = 'uuid',
            'payments_link_id existe y es uuid');
select t.ok((select is_nullable from information_schema.columns where table_schema='public' and table_name='payment_invoices' and column_name='payments_link_id') = 'YES',
            'payments_link_id es nullable (facturas viejas sin link)');
select t.ok((select count(*) from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey)
              where c.conrelid='public.payment_invoices'::regclass and c.contype='f' and a.attname='payments_link_id') = 0,
            'payments_link_id sin FK (payments no depende de public ni al reves)');
select t.ok(exists (select 1 from pg_indexes where schemaname='public' and indexname='payment_invoices_payments_link_id_idx' and indexdef ilike '%where%'),
            'indice parcial por payments_link_id');
insert into public.tenants(id, name) values ('a1000000-0000-4000-8000-000000000001', 'T-ST4') on conflict do nothing;
insert into public.payment_invoices(id, payer_tenant_id, provider_key, amount_cents, payments_link_id)
  values ('d1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'wompi', 1000, 'e1000000-0000-4000-8000-000000000001');
select t.ok((select payments_link_id from public.payment_invoices where id='d1000000-0000-4000-8000-000000000001') = 'e1000000-0000-4000-8000-000000000001'::uuid,
            'se puede guardar el id del link del servicio (sin existir en public)');
-- la factura existente sin link sigue valida
insert into public.payment_invoices(id, payer_tenant_id, provider_key, amount_cents)
  values ('d1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001', 'wompi', 1000);
select t.ok((select payments_link_id is null from public.payment_invoices where id='d1000000-0000-4000-8000-000000000002'), 'una factura sin link queda con payments_link_id null');
