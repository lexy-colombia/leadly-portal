-- ST4 / D9: simulacion extremo a extremo DESPUES de aplicar 20261020170000_barriles_prepaid_due_date.sql sobre la forma real
-- (Barriles + Faiver). El shell tomo antes t.pre (huella de todo lo demas) y aplico la migracion.
set client_min_messages = warning;
\set SU '00000000-0000-0000-0000-0000000000a1'
\set UB '00000000-0000-0000-0000-0000000000b2'
\set UF '00000000-0000-0000-0000-0000000000f2'
insert into public.profiles(id, tenant_id, role) values ('00000000-0000-0000-0000-0000000000b2', t.id('BAR'), 'tenant_admin'),
  ('00000000-0000-0000-0000-0000000000f2', t.id('FAI'), 'tenant_admin');
create function t.cnt(p_role text, p_uid uuid, p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claims', case when p_role is null then '' else json_build_object('role', p_role, 'sub', p_uid)::text end, true);
  if p_role in ('anon', 'authenticated', 'service_role') then execute format('set local role %I', p_role); end if;
  begin execute 'select count(*) from (' || p_sql || ') q' into n; exception when others then n := -1; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return n;
end $$;
create function t.subhash() returns text language sql stable as $$
  select md5(string_agg(id::text || status || current_period_start::text || current_period_end::text || cancel_at_period_end::text, '|' order by id)) from public.billing_subscriptions $$;
create function t.restinv() returns text language sql stable as $$
  select md5(coalesce(string_agg(id::text || period_start::text || period_end::text || due_date::text || status || coalesce(deleted_at::text,'-'), '|' order by id), ''))
  from public.payment_invoices where id <> '5851bd75-6fd7-4ae8-bae6-f2ec705e9010' $$;
\set INV '5851bd75-6fd7-4ae8-bae6-f2ec705e9010'

select t.chk('B1 la migracion cambio SOLO due_date del comprobante: ahora 2026-10-10, sigue PENDING, mismo periodo y monto',
  (select due_date = '2026-10-10' and status = 'PENDING' and period_start = '2026-10-10' and period_end = '2026-11-10' and amount_cents = 14000000 and deleted_at is null
   from public.payment_invoices where id = :'INV'));
select t.chk('B2 ningun otro comprobante cambio (huella), ni las suscripciones, ni los tenants',
  t.restinv() = (select v from t.pre where k = 'rest') and t.subhash() = (select v from t.pre where k = 'sub')
  and (select count(*) = 2 from public.tenants where status = 'active' and suspension_reason is null and id in (t.id('BAR'), t.id('FAI'))));
select t.setclock('2026-10-20 08:00:00-05');
select t.run_as('B3 el cron de mora (sin claims, como pg_cron) corre SIN error', null, null, 'select public.deactivate_tenants_with_overdue_invoices()', true);
select t.chk('B4 Barriles queda inactive con suspension_reason=nonpayment; Faiver sigue active sin motivo',
  (select status = 'inactive' and suspension_reason = 'nonpayment' from public.tenants where id = t.id('BAR'))
  and (select status = 'active' and suspension_reason is null from public.tenants where id = t.id('FAI')));
select t.chk('B5 el comprobante paso a OVERDUE', (select status = 'OVERDUE' from public.payment_invoices where id = :'INV'));
select t.chk('B6 el Barriles bloqueado lee su comprobante pendiente (politica de ST3), sin ver nada de Faiver',
  t.cnt('authenticated', :'UB', format('select * from public.payment_invoices where id = %L', :'INV')) = 1
  and t.cnt('authenticated', :'UB', format('select * from public.payment_invoices where payer_tenant_id = %L', t.id('FAI'))) = 0
  and t.cnt('authenticated', :'UB', 'select * from public.payment_invoices') = (select count(*) from public.payment_invoices where payer_tenant_id = t.id('BAR')));
select t.chk('B7 Faiver (activo) no lee el comprobante de Barriles', t.cnt('authenticated', :'UF', format('select * from public.payment_invoices where id = %L', :'INV')) = 0);
select t.chk('B8 el bloqueo no toco la suscripcion', t.subhash() = (select v from t.pre where k = 'sub'));

create function t.pay_bar() returns void language plpgsql as $$
declare r record;
begin
  select * into r from t.as_user('authenticated', '00000000-0000-0000-0000-0000000000a1',
    format('select public.record_manual_payment(%L, null, ''transferencia'', ''ref'', ''pago Barriles'')', '5851bd75-6fd7-4ae8-bae6-f2ec705e9010'));
  if not r.ok then raise exception 'pago manual fallo: %', r.msg; end if;
end $$;
select t.pay_bar();
select t.chk('B9 record_manual_payment: comprobante PAID y Barriles reactivado AL INSTANTE (trigger), motivo y fecha limpios',
  (select status = 'PAID' from public.payment_invoices where id = :'INV')
  and (select status = 'active' and suspension_reason is null and suspended_at is null from public.tenants where id = t.id('BAR')));
select t.chk('B10 la suscripcion no cambio (ACTIVE, mismo periodo)', t.subhash() = (select v from t.pre where k = 'sub'));
select t.chk('B11 pagado, ya no queda comprobante pendiente de Barriles',
  not exists (select 1 from public.payment_invoices where payer_tenant_id = t.id('BAR') and status in ('PENDING', 'OVERDUE') and deleted_at is null));
do $$
declare d date;
begin
  for d in select generate_series('2026-10-20'::date, '2026-10-30'::date, interval '1 day')::date loop
    perform t.setclock((d::text || ' 07:00:00-05')::timestamptz); perform public.process_recurring_billing_invoices();
    perform t.setclock((d::text || ' 08:00:00-05')::timestamptz); perform public.deactivate_tenants_with_overdue_invoices();
  end loop;
end $$;
select t.chk('B12 los crones siguientes (10 dias de 07:00/08:00) NO vuelven a bloquear a Barriles ni a Faiver',
  (select count(*) = 2 from public.tenants where status = 'active' and suspension_reason is null and id in (t.id('BAR'), t.id('FAI'))));
select t.chk('B13 sin duplicados ni omisiones: Barriles sigue con sus 2 comprobantes; Faiver recibio exactamente 1 nuevo (periodo 11-05, emitido el 10-29, vence 11-05), sin otros',
  (select count(*) = 2 from public.payment_invoices where payer_tenant_id = t.id('BAR') and deleted_at is null)
  and (select count(*) = 2 from public.payment_invoices where payer_tenant_id = t.id('FAI') and deleted_at is null)
  and (select count(*) = 1 from public.payment_invoices where payer_tenant_id = t.id('FAI') and period_start = '2026-11-05' and due_date = '2026-11-05' and status = 'PENDING'));
