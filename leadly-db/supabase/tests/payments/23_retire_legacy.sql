-- Estado final tras 20261017120000_payments_retire_legacy.sql (autocontenido: no usa el esquema t).
-- Se ejecuta como superusuario despues de aplicar la migracion dos veces.
\set ON_ERROR_STOP off
set client_min_messages = notice;
create or replace function pg_temp.ok(p_name text, p_cond boolean) returns void language plpgsql as $$
begin
  if p_cond then raise notice 'PASS %', p_name; else raise notice 'FAIL: %', p_name; end if;
end $$;

-- lo que se elimina
select pg_temp.ok('payments_record_legacy_event eliminada', not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='payments_record_legacy_event'));
select pg_temp.ok('payments_transaction_usage eliminada', not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='payments_transaction_usage'));
select pg_temp.ok('tabla sales_order_payment_links eliminada', to_regclass('public.sales_order_payment_links') is null);
select pg_temp.ok('payment_invoices.provider_checkout_id eliminada', not exists (select 1 from information_schema.columns where table_schema='public' and table_name='payment_invoices' and column_name='provider_checkout_id'));
select pg_temp.ok('indice de provider_checkout_id eliminado', to_regclass('public.payment_invoices_provider_checkout_id_idx') is null);
select pg_temp.ok('sales_order_payments.payment_link_id sigue existiendo, sin FK, con su indice unico parcial',
  exists (select 1 from information_schema.columns where table_schema='public' and table_name='sales_order_payments' and column_name='payment_link_id')
  and to_regclass('public.sales_order_payments_payment_link_idx') is not null);

-- lo que se conserva (historia inmutable)
select pg_temp.ok('columnas events.origin / origin_ref conservadas', (select count(*) from information_schema.columns where table_schema='payments' and table_name='events' and column_name in ('origin','origin_ref')) = 2);
select pg_temp.ok('CHECK de classification conserva los valores legacy_*',
  pg_get_constraintdef((select oid from pg_constraint where conname='events_classification_check' and conrelid='payments.events'::regclass)) like '%legacy_invoice%'
  and pg_get_constraintdef((select oid from pg_constraint where conname='events_classification_check' and conrelid='payments.events'::regclass)) like '%legacy_not_applied%');
select pg_temp.ok('CHECK de origin conservado', exists (select 1 from pg_constraint where conname='events_origin_check' and conrelid='payments.events'::regclass));

-- funciones reescritas: misma firma, una sola sobrecarga
select pg_temp.ok('payments_record_event: una sola firma (jsonb,text,boolean,jsonb)',
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='payments_record_event') = 1
  and to_regprocedure('public.payments_record_event(jsonb,text,boolean,jsonb)') is not null);
select pg_temp.ok('payments_public_link_status(uuid) y payments_health_summary(int) presentes',
  to_regprocedure('public.payments_public_link_status(uuid)') is not null and to_regprocedure('public.payments_health_summary(integer)') is not null);
select pg_temp.ok('health_summary sin legacy_not_applied (8 claves)',
  (select count(*) from jsonb_object_keys(public.payments_health_summary(24))) = 8
  and not (public.payments_health_summary(24) ? 'legacy_not_applied'));

-- grants: nada para public/anon/authenticated en ninguna payments_*
select pg_temp.ok('ninguna payments_* ejecutable por public/anon/authenticated tras la migracion', not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname like 'payments\_%'
     and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'))));
select pg_temp.ok('todas las payments_* ejecutables por service_role', not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname like 'payments\_%' and not has_function_privilege('service_role', p.oid, 'execute')));
select pg_temp.ok('las apply_wompi_* de ST3 siguen intactas y con su grant',
  has_function_privilege('service_role', 'public.apply_wompi_order_payment(uuid,uuid,uuid,text,bigint,bigint,text,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.apply_wompi_order_payment(uuid,uuid,uuid,text,bigint,bigint,text,text)', 'execute'));
