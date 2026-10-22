-- SIMULACION DEL TIEMPO con las 2 suscripciones REALES (forma de produccion, ver 05_prod_fixture.sql):
--   Barriles [10-10, 11-10] con PENDING [10-10, 11-10] (due 11-10);  Faiver [10-05, 11-05] PAID.
-- Reloj: 2026-10-20 -> 2027-03-05. Cada dia: 07:00 process_recurring_billing_invoices, 08:00 deactivate_tenants_with_overdue_invoices,
-- 12:00 pagos. Faiver paga cada comprobante el dia que vence. Barriles paga el dia que vence EXCEPTO el que vence 2027-01-10,
-- que paga el 2027-01-20 con record_manual_payment del superadmin (debe bloquearse del 01-14 al 01-20 y reactivarse al pagar).
set client_min_messages = warning;
create table t.simlog(day date, k text, tstatus text, reason text);
create table t.seen(inv uuid primary key, day date);
\set SU '00000000-0000-0000-0000-0000000000a1'

select t.chk('S0 estado inicial: Barriles y Faiver activos; 3 comprobantes', (select count(*) = 3 from public.payment_invoices)
  and (select count(*) = 2 from public.tenants where status = 'active' and id in (t.id('BAR'), t.id('FAI'))));
select t.setclock('2026-10-20 08:00:00-05');
insert into t.seen select id, '2026-10-20' from public.payment_invoices;

do $$
declare d date; r record; v_inv record;
begin
  for d in select generate_series('2026-10-20'::date, '2027-03-05'::date, interval '1 day')::date loop
    perform t.setclock((d::text || ' 07:00:00-05')::timestamptz);
    perform public.process_recurring_billing_invoices();
    insert into t.seen select id, d from public.payment_invoices on conflict do nothing;
    perform t.setclock((d::text || ' 08:00:00-05')::timestamptz);
    perform public.deactivate_tenants_with_overdue_invoices();
    perform t.setclock((d::text || ' 12:00:00-05')::timestamptz);
    -- Faiver: paga todo lo que vence hoy o antes
    for v_inv in select id from public.payment_invoices where payer_tenant_id = t.id('FAI') and status in ('PENDING', 'OVERDUE') and due_date <= d and deleted_at is null loop
      update public.payment_invoices set status = 'PAID' where id = v_inv.id;
    end loop;
    -- Barriles: paga el dia que vence, salvo el de 2027-01-10 (lo paga el 01-20 por pago manual del superadmin)
    for v_inv in select id, due_date from public.payment_invoices where payer_tenant_id = t.id('BAR') and status in ('PENDING', 'OVERDUE') and due_date <= d and deleted_at is null loop
      if v_inv.due_date = '2027-01-10' then
        if d >= '2027-01-20' then
          select * into r from t.as_user('authenticated', '00000000-0000-0000-0000-0000000000a1',
            format('select public.record_manual_payment(%L, null, ''transferencia'', ''sim'', ''sim'')', v_inv.id));
          if not r.ok then raise exception 'pago manual fallo %', r.msg; end if;
        end if;
      else
        update public.payment_invoices set status = 'PAID' where id = v_inv.id;
      end if;
    end loop;
    insert into t.simlog select d, 'BAR', status, suspension_reason from public.tenants where id = t.id('BAR');
    insert into t.simlog select d, 'FAI', status, suspension_reason from public.tenants where id = t.id('FAI');
  end loop;
end $$;

-- ---- comprobantes por suscripcion: esperado calculado de forma INDEPENDIENTE (aritmetica de meses desde el inicio historico)
create function t.expected_starts(p_first date, p_end date) returns date[] language sql as $$
  select array_agg((p_first + k * interval '1 month')::date order by k)
  from generate_series(0, 60) k where (p_first + k * interval '1 month')::date - 7 <= p_end $$;

select t.chk('S1 Barriles: inicios de periodo = exactamente la serie esperada (ninguna omitida, ninguna duplicada)',
  (select array_agg(period_start order by period_start) from public.payment_invoices where subscription_id = 'b0b0b0b0-0000-4000-8000-000000000001')
   = t.expected_starts('2026-09-10', '2027-03-05'),
  (select array_agg(period_start order by period_start)::text from public.payment_invoices where subscription_id = 'b0b0b0b0-0000-4000-8000-000000000001'));
select t.chk('S2 Faiver: inicios de periodo = exactamente la serie esperada',
  (select array_agg(period_start order by period_start) from public.payment_invoices where subscription_id = 'fa1fa1fa-0000-4000-8000-000000000001')
   = t.expected_starts('2026-10-05', '2027-03-05'),
  (select array_agg(period_start order by period_start)::text from public.payment_invoices where subscription_id = 'fa1fa1fa-0000-4000-8000-000000000001'));
select t.chk('S3 cifras: Barriles 7 comprobantes, Faiver 6 (a 2027-03-05)',
  (select count(*) from public.payment_invoices where subscription_id = 'b0b0b0b0-0000-4000-8000-000000000001') = 7
  and (select count(*) from public.payment_invoices where subscription_id = 'fa1fa1fa-0000-4000-8000-000000000001') = 6,
  (select count(*) from public.payment_invoices where subscription_id = 'b0b0b0b0-0000-4000-8000-000000000001') || '/' ||
  (select count(*) from public.payment_invoices where subscription_id = 'fa1fa1fa-0000-4000-8000-000000000001'));
select t.chk('S4 ningun periodo duplicado entre comprobantes vivos (ninguna combinacion suscripcion+inicio repetida)',
  (select count(*) = 0 from (select subscription_id, period_start from public.payment_invoices where deleted_at is null group by 1, 2 having count(*) > 1) z));
select t.chk('S5 periodos contiguos: cada uno empieza donde termina el anterior (ambas suscripciones)',
  (select coalesce(bool_and(period_start = prev_end), true) from (select period_start, lag(period_end) over (partition by subscription_id order by period_start) prev_end
     from public.payment_invoices) z where prev_end is not null));
select t.chk('S6 comprobantes nuevos: se emitieron 7 dias antes del inicio y vencen el dia que empieza el periodo',
  (select count(*) = 10 and bool_and(i.period_start - s.day = 7 and i.due_date = i.period_start) from public.payment_invoices i join t.seen s on s.inv = i.id
   where s.day > '2026-10-20'),
  (select count(*)::text from public.payment_invoices i join t.seen s on s.inv = i.id where s.day > '2026-10-20'));
select t.chk('S7 periodo vigente al 2027-03-05: Barriles [02-10, 03-10], Faiver [03-05, 04-05] (avanzaron solo al terminar)',
  (select current_period_start = '2027-02-10 00:00:00-05' and current_period_end = '2027-03-10 00:00:00-05' from public.billing_subscriptions where id = 'b0b0b0b0-0000-4000-8000-000000000001')
  and (select current_period_start = '2027-03-05 00:00:00-05' and current_period_end = '2027-04-05 00:00:00-05' from public.billing_subscriptions where id = 'fa1fa1fa-0000-4000-8000-000000000001'));
select t.chk('S8 los items de las renovaciones de Barriles (5) conservan base + modulos a $0 (sin implementacion)',
  (select count(*) = 5 and bool_and(n = 3 and total = 14000000 and impl = 0) from (
     select p.id, count(i.*) n, sum(i.subtotal_cents) total, count(*) filter (where i.description like 'Implementaci%') impl
     from public.payment_invoices p join public.payment_invoice_items i on i.invoice_id = p.id
     where p.subscription_id = 'b0b0b0b0-0000-4000-8000-000000000001' and p.period_start >= '2026-11-10' group by p.id) z));

-- ---- mora: el bloqueo del cron funciona de punta a punta
select t.chk('S9 Barriles: NUNCA bloqueado antes del 2027-01-14', (select count(*) = 0 from t.simlog where k = 'BAR' and tstatus = 'inactive' and day < '2027-01-14'));
select t.chk('S10 Barriles: bloqueado por mora del 2027-01-14 al 2027-01-19 (6 dias, nonpayment)',
  (select count(*) = 6 and bool_and(reason = 'nonpayment') and min(day) = '2027-01-14' and max(day) = '2027-01-19' from t.simlog where k = 'BAR' and tstatus = 'inactive'),
  (select min(day) || '..' || max(day) || ' n=' || count(*) from t.simlog where k = 'BAR' and tstatus = 'inactive'));
select t.chk('S11 Barriles: reactivado el 2027-01-20 (pago manual -> trigger) y activo hasta el final',
  (select count(*) = 0 from t.simlog where k = 'BAR' and day >= '2027-01-20' and tstatus <> 'active')
  and (select suspension_reason is null and suspended_at is null from public.tenants where id = t.id('BAR')));
select t.chk('S12 Faiver (paga a tiempo): nunca bloqueado en 137 dias', (select count(*) = 137 and bool_and(tstatus = 'active') from t.simlog where k = 'FAI'));
select t.chk('S13 el comprobante de Barriles vencido el 01-10 paso por OVERDUE y termino PAID',
  exists (select 1 from public.payment_invoices where subscription_id = 'b0b0b0b0-0000-4000-8000-000000000001' and due_date = '2027-01-10' and status = 'PAID'));
select t.chk('S14 el bloqueo no impidio la emision del siguiente comprobante de Barriles (02-10 emitido el 02-03)',
  (select s.day = '2027-02-03' from public.payment_invoices i join t.seen s on s.inv = i.id where i.subscription_id = 'b0b0b0b0-0000-4000-8000-000000000001' and i.period_start = '2027-02-10'));
