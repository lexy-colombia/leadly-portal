-- D3: ciclo en dos pasos (emitir con adelanto sin avanzar; avanzar al terminar). Reloj falso: cada dia 07:00 corre el cron.
set client_min_messages = warning;
select t.tenant(k) from unnest(array['LATE', 'ME', 'YE', 'CE', 'PP', 'PD']) k;
create table t.cyc(day date, k text, n bigint, ps timestamptz, pe timestamptz, st text);
create function t.snap(p_day date) returns void language sql as $$
  insert into t.cyc select p_day, x.k, t.ninv(s.id), s.current_period_start, s.current_period_end, s.status
  from (values ('ME'), ('YE'), ('CE'), ('PP'), ('PD')) x(k) join public.billing_subscriptions s on s.id = t.sub_of(x.k) $$;

-- suscripcion con periodo ya terminado hace dias (renovacion TARDIA): cron del 2026-03-15
select t.setclock('2026-03-15 07:00:00-05');
insert into public.billing_subscriptions(tenant_id, plan_id, status, current_period_start, current_period_end)
  select t.id('LATE'), id, 'ACTIVE', '2026-02-01 00:00:00-05', '2026-03-01 00:00:00-05' from public.billing_plans where key = 'zz_m';
select t.chk('L0 alta ACTIVE con periodo historico: 1 comprobante inicial [02-01, 03-01]', t.ninv(t.sub_of('LATE')) = 1
  and (select period_start = '2026-02-01' from public.payment_invoices where subscription_id = t.sub_of('LATE')));
select public.process_recurring_billing_invoices();
select public.process_recurring_billing_invoices();
select t.chk('L1 renovacion tardia: UNA sola factura nueva [03-01, 04-01] que vence HOY (03-15), y el periodo avanzo a [03-01, 04-01]',
  t.ninv(t.sub_of('LATE')) = 2
  and exists (select 1 from public.payment_invoices where subscription_id = t.sub_of('LATE') and period_start = '2026-03-01' and period_end = '2026-04-01' and due_date = '2026-03-15')
  and (select current_period_start = '2026-03-01 00:00:00-05' and current_period_end = '2026-04-01 00:00:00-05' from public.billing_subscriptions where id = t.sub_of('LATE')));

-- suscripciones del recorrido (todas con su comprobante inicial ya pagado)
select t.setclock('2026-03-01 10:00:00-05');
insert into public.billing_subscriptions(tenant_id, plan_id, status, current_period_start, current_period_end, cancel_at_period_end)
  select t.id(x.k), p.id, x.st, x.ps::timestamptz, x.pe::timestamptz, x.cap from (values
    ('ME', 'zz_m', 'ACTIVE', '2026-03-01 00:00:00-05', '2026-04-01 00:00:00-05', false),
    ('YE', 'zz_y', 'ACTIVE', '2026-03-01 00:00:00-05', '2027-03-01 00:00:00-05', false),
    ('CE', 'zz_m', 'ACTIVE', '2026-03-01 00:00:00-05', '2026-04-01 00:00:00-05', true),
    ('PP', 'zz_m', 'PENDING_PAYMENT', '2026-03-01 00:00:00-05', '2026-04-01 00:00:00-05', false),
    ('PD', 'zz_m', 'PAST_DUE', '2026-03-01 00:00:00-05', '2026-04-01 00:00:00-05', false)) x(k, pk, st, ps, pe, cap)
  join public.billing_plans p on p.key = x.pk;
-- ME/YE/CE pagan su inicial (PP/PD no: pagarla las pasaria a ACTIVE y dejarian de probar el filtro de estado)
update public.payment_invoices set status = 'PAID' where payer_tenant_id in (t.id('ME'), t.id('YE'), t.id('CE'));
-- la factura inicial de cada una vence HOY (2026-03-01): como el recorrido no corre mora, no importa
select t.chk('C0 comprobantes iniciales: 1 por suscripcion, periodo desde current_period_start',
  (select count(*) = 5 and bool_and(period_start = '2026-03-01') from public.payment_invoices where payer_tenant_id in (t.id('ME'), t.id('YE'), t.id('CE'), t.id('PP'), t.id('PD'))));

do $$
declare d date;
begin
  perform t.snap('2026-03-01'::date);
  for d in select generate_series('2026-03-02'::date, '2027-03-03'::date, interval '1 day')::date loop
    perform t.setclock((d::text || ' 07:00:00-05')::timestamptz);
    perform public.process_recurring_billing_invoices();
    perform t.snap(d);
  end loop;
end $$;

-- mensual
select t.chk('C1 mensual: 1a emision EL 2026-03-25 (7 dias antes del inicio 04-01)',
  (select min(day) from t.cyc where k = 'ME' and n = 2) = '2026-03-25');
select t.chk('C2 mensual: el dia 03-24 aun no habia emision (n=1)',
  (select n from t.cyc where k = 'ME' and day = '2026-03-24') = 1);
select t.chk('C3 mensual: emitir NO avanza el periodo (03-25 a 03-31 sigue [03-01, 04-01])',
  (select count(*) = 7 and bool_and(ps = '2026-03-01 00:00:00-05' and pe = '2026-04-01 00:00:00-05') from t.cyc where k = 'ME' and day between '2026-03-25' and '2026-03-31'));
select t.chk('C4 mensual: el periodo avanza al terminar (04-01: [04-01, 05-01]) y NO se duplica el comprobante (n=2 hasta 04-03)',
  (select ps = '2026-04-01 00:00:00-05' and pe = '2026-05-01 00:00:00-05' and n = 2 from t.cyc where k = 'ME' and day = '2026-04-01')
  and (select bool_and(n = 2) from t.cyc where k = 'ME' and day between '2026-03-25' and '2026-04-23'));
select t.chk('C5 mensual: el comprobante emitido vence el dia que empieza el periodo (04-01), cubre [04-01, 05-01], PENDING',
  exists (select 1 from public.payment_invoices where subscription_id = t.sub_of('ME') and period_start = '2026-04-01'
          and period_end = '2026-05-01' and due_date = '2026-04-01' and status = 'PENDING'));
select t.chk('C6 mensual 12 meses: periodos consecutivos sin saltos ni duplicados (13 comprobantes a 2027-03-03, inicios dia 1 de cada mes)',
  (select count(*) = 13 and count(distinct period_start) = 13 and bool_and(period_start = ('2026-03-01'::date + (rn - 1) * interval '1 month')::date)
   from (select period_start, row_number() over (order by period_start) rn from public.payment_invoices where subscription_id = t.sub_of('ME')) z));
select t.chk('C6b mensual: cada periodo empieza donde terminó el anterior',
  (select bool_and(period_start = prev_end) from (select period_start, lag(period_end) over (order by period_start) prev_end,
     row_number() over (order by period_start) rn from public.payment_invoices where subscription_id = t.sub_of('ME')) z where rn > 1));
select t.chk('C6c mensual: toda renovacion vence el dia que empieza su periodo',
  (select bool_and(due_date = period_start) from public.payment_invoices where subscription_id = t.sub_of('ME') and period_start > '2026-03-01'));
-- anual
select t.chk('C7 anual: 1a emision EL 2027-01-30 (30 dias antes del inicio 2027-03-01); el dia anterior no',
  (select min(day) from t.cyc where k = 'YE' and n = 2) = '2027-01-30'
  and (select n from t.cyc where k = 'YE' and day = '2027-01-29') = 1);
select t.chk('C8 anual: comprobante [2027-03-01, 2028-03-01] vence 2027-03-01; periodo sin avanzar hasta el 03-01 y luego [2027-03-01, 2028-03-01]',
  exists (select 1 from public.payment_invoices where subscription_id = t.sub_of('YE') and period_start = '2027-03-01'
          and period_end = '2028-03-01' and due_date = '2027-03-01')
  and (select bool_and(ps = '2026-03-01 00:00:00-05' and pe = '2027-03-01 00:00:00-05') from t.cyc where k = 'YE' and day between '2027-01-30' and '2027-02-28')
  and (select ps = '2027-03-01 00:00:00-05' and pe = '2028-03-01 00:00:00-05' and n = 2 from t.cyc where k = 'YE' and day = '2027-03-01'));
select t.chk('C8b anual: nunca mas de 2 comprobantes en todo el recorrido', (select max(n) = 2 from t.cyc where k = 'YE'));
-- cancel_at_period_end
select t.chk('C9 cancel_at_period_end: no se emite renovacion (n=1) y se cancela al terminar el periodo (04-01)',
  (select bool_and(n = 1) from t.cyc where k = 'CE')
  and (select st = 'CANCELLED' from t.cyc where k = 'CE' and day = '2026-04-01')
  and (select st = 'ACTIVE' from t.cyc where k = 'CE' and day = '2026-03-31'));
-- estados no activos
select t.chk('C10 PENDING_PAYMENT y PAST_DUE nunca se renuevan por cron (n=1, periodo intacto)',
  (select bool_and(n = 1 and ps = '2026-03-01 00:00:00-05' and pe = '2026-04-01 00:00:00-05') from t.cyc where k in ('PP', 'PD')));
-- doble corrida el mismo dia
do $$
declare v_before bigint; v_after bigint;
begin
  perform t.setclock('2027-03-02 07:00:00-05');
  v_before := (select count(*) from public.payment_invoices);
  perform public.process_recurring_billing_invoices();
  perform public.process_recurring_billing_invoices();
  v_after := (select count(*) from public.payment_invoices);
  perform t.chk('C11 idempotencia: correr el cron dos veces mas el mismo dia no crea facturas', v_before = v_after, v_before || ' -> ' || v_after);
end $$;
