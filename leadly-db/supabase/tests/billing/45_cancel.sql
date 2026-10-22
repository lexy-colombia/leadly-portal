-- H1: cancelar dentro de la ventana de emision anula (soft-delete) los comprobantes de periodos futuros.
set client_min_messages = warning;
select t.tenant(k) from unnest(array['KC', 'KD', 'KR', 'KN', 'KI', 'KS']) k;
create function t.mk_sub(p_k text, p_ps timestamptz, p_pe timestamptz, p_paid boolean) returns void language plpgsql as $$
begin
  insert into public.billing_subscriptions(tenant_id, plan_id, status, current_period_start, current_period_end)
    select t.id(p_k), id, 'ACTIVE', p_ps, p_pe from public.billing_plans where key = 'zz_m';
  if p_paid then update public.payment_invoices set status = 'PAID' where subscription_id = t.sub_of(p_k); end if;
end $$;
create function t.live(p_k text, p_ps date) returns boolean language sql stable as $$
  select exists (select 1 from public.payment_invoices where subscription_id = t.sub_of(p_k) and period_start = p_ps and deleted_at is null) $$;
create function t.cancel(p_k text) returns void language plpgsql as $$
declare r record;
begin
  select * into r from t.as_user('authenticated', '00000000-0000-0000-0000-0000000000a1', format('select public.cancel_subscription(%L)', t.sub_of(p_k)));
  if not r.ok then raise exception 'cancel fallo: %', r.msg; end if;
end $$;

-- K1: KC (inicial pagado) y KD (inicial SIN pagar). Cron del 03-26 emite [04-01] a ambos; se cancela el 03-27.
select t.setclock('2026-03-01 10:00:00-05');
select t.mk_sub('KC', '2026-03-01 00:00:00-05', '2026-04-01 00:00:00-05', true);
select t.mk_sub('KD', '2026-03-01 00:00:00-05', '2026-04-01 00:00:00-05', false);
select t.setclock('2026-03-26 07:00:00-05'); select public.process_recurring_billing_invoices();
select t.chk('K0 el cron emitio el comprobante futuro [04-01] a KC y KD', t.live('KC', '2026-04-01') and t.live('KD', '2026-04-01'));
select t.setclock('2026-03-27 10:00:00-05');
select t.cancel('KC'); select t.cancel('KD');
select t.chk('K1 cancelar en la ventana programa la cancelacion (sigue ACTIVE) y ANULA el comprobante futuro (deleted_at/deleted_by)',
  (select cancel_at_period_end and status = 'ACTIVE' from public.billing_subscriptions where id = t.sub_of('KC'))
  and not t.live('KC', '2026-04-01')
  and (select deleted_at = '2026-03-27 10:00:00-05' and deleted_by = '00000000-0000-0000-0000-0000000000a1' from public.payment_invoices where subscription_id = t.sub_of('KC') and period_start = '2026-04-01'));
select t.chk('K2 NO se borra de verdad: la fila anulada sigue en la tabla (soft-delete)',
  (select count(*) = 1 from public.payment_invoices where subscription_id = t.sub_of('KC') and period_start = '2026-04-01'));
select t.chk('K3 NO se toca el periodo vigente ni lo PAID: KC conserva su comprobante [03-01] PAID vivo',
  t.live('KC', '2026-03-01') and (select status = 'PAID' from public.payment_invoices where subscription_id = t.sub_of('KC') and period_start = '2026-03-01'));
select t.chk('K4 NO se toca el comprobante del periodo VIGENTE aunque este PENDING (KD [03-01] sigue vivo y PENDING)',
  t.live('KD', '2026-03-01') and (select status = 'PENDING' from public.payment_invoices where subscription_id = t.sub_of('KD') and period_start = '2026-03-01')
  and not t.live('KD', '2026-04-01'));
-- sin bloqueo posterior para KC: el recorrido hasta 04-10 con cron de mora
do $$
declare d date;
begin
  for d in select generate_series('2026-03-28'::date, '2026-04-10'::date, interval '1 day')::date loop
    perform t.setclock((d::text || ' 07:00:00-05')::timestamptz);
    perform public.process_recurring_billing_invoices();
    perform public.deactivate_tenants_with_overdue_invoices();
  end loop;
  perform t.chk('K5 el cliente que cancelo NO queda bloqueado por mora (KC activo a 04-10) y la suscripcion paso a CANCELLED sin comprobante nuevo',
    (select status = 'active' from public.tenants where id = t.id('KC'))
    and (select status = 'CANCELLED' from public.billing_subscriptions where id = t.sub_of('KC'))
    and t.ninv(t.sub_of('KC')) = 1);
end $$;

-- K6: reanudar. KR cancela dentro de la ventana y luego reanuda; el cron emite de nuevo sin duplicar ni dejar hueco.
select t.setclock('2026-03-01 10:00:00-05');
select t.mk_sub('KR', '2026-03-01 00:00:00-05', '2026-04-01 00:00:00-05', true);
select t.setclock('2026-03-26 07:00:00-05'); select public.process_recurring_billing_invoices();
select t.setclock('2026-03-27 10:00:00-05'); select t.cancel('KR');
select t.chk('K6a KR cancelada: comprobante futuro anulado', not t.live('KR', '2026-04-01'));
select t.run_as('K6b el superadmin reanuda (reactivate_subscription)', 'authenticated', '00000000-0000-0000-0000-0000000000a1'::uuid,
  format('select public.reactivate_subscription(%L)', t.sub_of('KR')), true);
select t.setclock('2026-03-28 07:00:00-05'); select public.process_recurring_billing_invoices(); select public.process_recurring_billing_invoices();
select t.chk('K6c al reanudar el cron re-emite [04-01] UNA vez (1 vivo + 1 anulado), vence 04-01, sin violar el indice ni duplicar',
  (select count(*) filter (where deleted_at is null) = 2 and count(*) filter (where deleted_at is not null) = 1 from public.payment_invoices where subscription_id = t.sub_of('KR'))
  and (select count(*) = 1 and bool_and(due_date = '2026-04-01') from public.payment_invoices where subscription_id = t.sub_of('KR') and period_start = '2026-04-01' and deleted_at is null));
select t.setclock('2026-04-01 07:00:00-05'); select public.process_recurring_billing_invoices();
select t.chk('K6d el periodo avanza normal tras reanudar [04-01, 05-01] y sigue ACTIVE',
  (select status = 'ACTIVE' and current_period_start = '2026-04-01 00:00:00-05' and current_period_end = '2026-05-01 00:00:00-05' from public.billing_subscriptions where id = t.sub_of('KR')));

-- K7: cancelar sin comprobante futuro no falla
select t.setclock('2026-03-10 10:00:00-05');
select t.mk_sub('KN', '2026-03-01 00:00:00-05', '2026-04-01 00:00:00-05', true);
select t.run_as('K7 cancelar sin comprobante futuro (fuera de la ventana) no falla y no anula nada', 'authenticated', '00000000-0000-0000-0000-0000000000a1'::uuid,
  format('select public.cancel_subscription(%L)', t.sub_of('KN')), true);
select t.chk('K7b ... y el comprobante vigente sigue vivo', t.live('KN', '2026-03-01') and t.ninv(t.sub_of('KN')) = 1);

-- K8: rama de cancelacion INMEDIATA (periodo ya terminado, sin cron en medio)
select t.setclock('2026-02-10 10:00:00-05');
select t.mk_sub('KI', '2026-02-01 00:00:00-05', '2026-03-01 00:00:00-05', true);
select t.setclock('2026-02-24 07:00:00-05'); select public.process_recurring_billing_invoices();
select t.chk('K8a KI tiene su comprobante futuro [03-01]', t.live('KI', '2026-03-01'));
select t.setclock('2026-03-02 10:00:00-05'); select t.cancel('KI');
select t.chk('K8b cancelacion inmediata (periodo ya vencido): CANCELLED y comprobante futuro anulado',
  (select status = 'CANCELLED' from public.billing_subscriptions where id = t.sub_of('KI')) and not t.live('KI', '2026-03-01'));

-- K9: cancelacion programada por fuera de cancel_subscription: el paso CANCEL del cron anula el futuro
select t.setclock('2026-03-01 10:00:00-05');
select t.mk_sub('KS', '2026-03-01 00:00:00-05', '2026-04-01 00:00:00-05', true);
select t.setclock('2026-03-26 07:00:00-05'); select public.process_recurring_billing_invoices();
update public.billing_subscriptions set cancel_at_period_end = true where id = t.sub_of('KS');
select t.chk('K9a (control) el flag puesto a mano no anula nada todavia', t.live('KS', '2026-04-01'));
select t.setclock('2026-04-01 07:00:00-05'); select public.process_recurring_billing_invoices();
select t.chk('K9b el paso CANCEL del cron cancela y anula el comprobante futuro',
  (select status = 'CANCELLED' from public.billing_subscriptions where id = t.sub_of('KS')) and not t.live('KS', '2026-04-01'));
-- privilegios
select t.run_as('K10 authenticated NO puede anular comprobantes directamente', 'authenticated', '00000000-0000-0000-0000-0000000000a1'::uuid,
  format('select public.annul_future_invoices(%L)', t.sub_of('KS')), false, '%permission denied%');
select t.run_as('K11 un tenant (no superadmin) no puede cancelar suscripciones', 'authenticated', '00000000-0000-0000-0000-0000000000ee'::uuid,
  format('select public.cancel_subscription(%L)', t.sub_of('KR')), false, 'Solo el superadmin%');
