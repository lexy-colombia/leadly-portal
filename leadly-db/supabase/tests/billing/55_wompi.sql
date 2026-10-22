-- H6: apply_wompi_invoice_payment REAL (extraida de 20261016130000) + trigger de reactivacion.
set client_min_messages = warning;
select t.setclock('2026-10-20 08:00:00-05');
select t.tenant(k) from unnest(array['W1', 'W2', 'W3']) k;
create function t.st(p_k text) returns text language sql stable as $$ select status || '/' || coalesce(suspension_reason, '-') from public.tenants where id = t.id(p_k) $$;
create function t.wompi(p_inv uuid, p_tenant uuid, p_tx text, out j jsonb, out ok boolean, out msg text) language plpgsql as $$
declare r record;
begin
  select * into r from t.as_user('service_role', null,
    format('create temp table if not exists wres(j jsonb); delete from wres; insert into wres select public.apply_wompi_invoice_payment(%L, %L, %L, 1000000, 1000000, ''COP'', ''{"method":"CARD"}'')', p_inv, p_tenant, p_tx));
  ok := r.ok; msg := r.msg;
  if r.ok then select w.j into j from wres w limit 1; end if;
end $$;
-- W1: bloqueado por mora, paga por Wompi -> se reactiva
select t.mk_inv(t.id('W1'), date '2026-10-01') as inv \gset w1_
select public.deactivate_tenants_with_overdue_invoices();
select t.chk('W0 W1 bloqueado por mora', t.st('W1') = 'inactive/nonpayment');
select (t.wompi(:'w1_inv'::uuid, t.id('W1'), 'tx-w1')).ok as ok \gset w1r_
select t.chk('W1a apply_wompi_invoice_payment (service_role) se ejecuto sin error', :'w1r_ok'::boolean);
select t.chk('W1b el comprobante quedo PAID con la transaccion de Wompi y hay un payment_attempt APPROVED',
  (select status = 'PAID' and provider_transaction_id = 'tx-w1' from public.payment_invoices where id = :'w1_inv'::uuid)
  and (select count(*) = 1 from public.payment_attempts where invoice_id = :'w1_inv'::uuid and status = 'APPROVED'));
select t.chk('W1c pago por Wompi de un comprobante en mora REACTIVA al tenant bloqueado por mora (service_role pasa el guard)', t.st('W1') = 'active/-');
-- W2: bloqueo MANUAL con deuda vencida, paga por Wompi -> sigue bloqueado
select t.mk_inv(t.id('W2'), date '2026-10-01') as inv \gset w2_
update public.tenants set status = 'inactive' where id = t.id('W2');
select (t.wompi(:'w2_inv'::uuid, t.id('W2'), 'tx-w2')).ok as ok \gset w2r_
select t.chk('W2a pago Wompi aplicado', :'w2r_ok'::boolean and (select status = 'PAID' from public.payment_invoices where id = :'w2_inv'::uuid));
select t.chk('W2b un bloqueo MANUAL no se reactiva por pagar con Wompi', t.st('W2') = 'inactive/-');
select public.deactivate_tenants_with_overdue_invoices();
select t.chk('W2c ... ni tras la corrida del cron', t.st('W2') = 'inactive/-');
-- W3: tenant ajeno / monto ajeno no reactivan
select t.mk_inv(t.id('W3'), date '2026-10-01') as inv \gset w3_
select public.deactivate_tenants_with_overdue_invoices();
select (t.wompi(:'w3_inv'::uuid, t.id('W1'), 'tx-w3')).j ->> 'reason' as reason \gset w3r_
select t.chk('W3 un sobre con otro tenant no acredita (tenant_mismatch) y W3 sigue bloqueado', :'w3r_reason' = 'tenant_mismatch' and t.st('W3') = 'inactive/nonpayment');
