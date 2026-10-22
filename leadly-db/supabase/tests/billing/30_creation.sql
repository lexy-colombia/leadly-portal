-- D2: creacion de comprobantes (cobro anticipado: primera vence hoy; items, custom, setup, total 0, dedupe).
set client_min_messages = warning;
select t.setclock('2026-01-15 10:00:00-05');
select t.tenant(k) from unnest(array['M','Y','C','FREE','STALE','DD']) k;

-- F1 mensual
insert into public.billing_subscriptions(tenant_id, plan_id) select t.id('M'), id from public.billing_plans where key = 'zz_m';
select t.chk('F1 mensual nueva: 1 comprobante PENDING que vence HOY (2026-01-15), periodo [01-15, 02-15]',
  (select count(*) = 1 and bool_and(due_date = '2026-01-15' and period_start = '2026-01-15' and period_end = '2026-02-15'
          and status = 'PENDING' and amount_cents = 10000000)
   from public.payment_invoices where payer_tenant_id = t.id('M')));
-- F2 anual
insert into public.billing_subscriptions(tenant_id, plan_id) select t.id('Y'), id from public.billing_plans where key = 'zz_y';
select t.chk('F2 anual nueva: vence HOY (2026-01-15), periodo [2026-01-15, 2027-01-15]',
  (select count(*) = 1 and bool_and(due_date = '2026-01-15' and period_start = '2026-01-15' and period_end = '2027-01-15')
   from public.payment_invoices where payer_tenant_id = t.id('Y')));

-- F3 plan a la medida: sin precio no factura; negociacion con modulos y setup fee
insert into public.billing_subscriptions(tenant_id, plan_id) select t.id('C'), id from public.billing_plans where key = 'zz_c';
select t.chk('F3a plan custom sin precio (total 0): NO se crea comprobante y no se activa',
  t.ninv(t.sub_of('C')) = 0 and (select status from public.billing_subscriptions where id = t.sub_of('C')) = 'PENDING_PAYMENT');
update public.billing_subscriptions set custom_base_amount_cents = 14000000, setup_fee_override_cents = 500000 where id = t.sub_of('C');
insert into public.billing_subscription_modules(subscription_id, module_key, price_cents, note) values
  (t.sub_of('C'), 'reports', 100000, 'soporte premium'), (t.sub_of('C'), 'sales', 0, null);
select t.run_as('F3b negociacion: superadmin genera el comprobante (llamada de 1 argumento, como lib/api/billing.ts)',
  'authenticated', '00000000-0000-0000-0000-0000000000a1', format('select public.create_invoice_for_subscription(%L)', t.sub_of('C')), true);
select t.chk('F3c total = base + modulos + setup = 14.600.000, vence HOY, periodo vigente [01-15, 02-15]',
  (select count(*) = 1 and bool_and(amount_cents = 14600000 and due_date = '2026-01-15' and period_start = '2026-01-15' and period_end = '2026-02-15')
   from public.payment_invoices where subscription_id = t.sub_of('C')));
select t.chk('F3d items: base, modulos (orden por clave, con nota) e Implementacion',
  (select array_agg(description order by display_order) = array['Zz a la medida', 'Módulo: Reportes — soporte premium', 'Módulo: Ventas', 'Implementación — Zz a la medida']
   from public.payment_invoice_items where invoice_id = (select id from public.payment_invoices where subscription_id = t.sub_of('C'))));
select t.chk('F3e setup_fee_billed_at fijado tras la primera factura',
  (select setup_fee_billed_at is not null from public.billing_subscriptions where id = t.sub_of('C')));
-- renovacion explicita (camino del cron: sin claims)
select public.create_invoice_for_subscription(t.sub_of('C'), date '2026-02-15');
select t.chk('F3f renovacion [02-15, 03-15]: vence el dia que empieza (02-15), SIN implementacion, total 14.100.000',
  (select count(*) = 1 and bool_and(amount_cents = 14100000 and due_date = '2026-02-15' and period_end = '2026-03-15')
   from public.payment_invoices where subscription_id = t.sub_of('C') and period_start = '2026-02-15')
  and not exists (select 1 from public.payment_invoice_items i join public.payment_invoices p on p.id = i.invoice_id
                  where p.subscription_id = t.sub_of('C') and p.period_start = '2026-02-15' and i.description like 'Implementaci%'));
do $$
declare v_id uuid;
begin
  v_id := public.create_invoice_for_subscription(t.sub_of('C'), date '2025-12-01');
  perform t.chk('F3g renovacion con period_start en el pasado: vence HOY, no nace vencida',
    v_id is not null and (select due_date from public.payment_invoices where id = v_id) = '2026-01-15');
end $$;

-- F4 atajo total 0
insert into public.billing_subscriptions(tenant_id, plan_id) select t.id('FREE'), id from public.billing_plans where key = 'zz_free';
select t.chk('F4 plan NO custom en 0: comprobante nace PAID, suscripcion pasa a ACTIVE',
  (select status = 'PAID' and amount_cents = 0 and due_date = '2026-01-15' from public.payment_invoices where payer_tenant_id = t.id('FREE'))
  and (select status from public.billing_subscriptions where id = t.sub_of('FREE')) = 'ACTIVE');

-- F6 reinicio de periodo PENDING_PAYMENT con periodo vencido
insert into public.billing_subscriptions(tenant_id, plan_id, current_period_start, current_period_end)
  select t.id('STALE'), id, '2025-01-01', '2025-02-01' from public.billing_plans where key = 'zz_m';
select t.chk('F6 PENDING_PAYMENT con periodo vencido: se reinicia a [ahora, +1 mes] y el comprobante vence hoy con ese periodo',
  (select current_period_start = '2026-01-15 10:00:00-05' and current_period_end = '2026-02-15 10:00:00-05' from public.billing_subscriptions where id = t.sub_of('STALE'))
  and (select count(*) = 1 and bool_and(due_date = '2026-01-15' and period_start = '2026-01-15' and period_end = '2026-02-15')
       from public.payment_invoices where payer_tenant_id = t.id('STALE')));

-- F7 dedupe por periodo
select t.chk('F7a repetir la llamada del periodo vigente devuelve NULL (no duplica)',
  public.create_invoice_for_subscription(t.sub_of('M')) is null and t.ninv(t.sub_of('M')) = 1);
select t.chk('F7b repetir con period_start explicito del mismo periodo devuelve NULL',
  public.create_invoice_for_subscription(t.sub_of('M'), date '2026-01-15') is null and t.ninv(t.sub_of('M')) = 1);
select t.run_as('F7c el indice impide el duplicado aunque se salte la funcion', null, null,
  format($q$insert into public.payment_invoices(payer_tenant_id, subscription_id, provider_key, amount_cents, due_date, period_start, period_end)
            values (%L, %L, 'wompi', 1, '2026-01-15', '2026-01-15', '2026-02-15')$q$, t.id('M'), t.sub_of('M')),
  false, '%payment_invoices_subscription_period_uidx%');
update public.payment_invoices set deleted_at = now() where subscription_id = t.sub_of('M');
select t.chk('F7d un comprobante eliminado (deleted_at) libera el periodo: se puede volver a emitir',
  public.create_invoice_for_subscription(t.sub_of('M')) is not null);
-- si una suscripcion tiene una factura CANCELLED del periodo, tambien bloquea (comportamiento previo)
update public.payment_invoices set status = 'CANCELLED' where subscription_id = t.sub_of('M') and deleted_at is null;
select t.chk('F7e una factura CANCELLED del mismo periodo tambien impide re-emitir (igual que antes)',
  public.create_invoice_for_subscription(t.sub_of('M')) is null);

-- guarda y privilegios de create_invoice_for_subscription
insert into public.profiles(id, tenant_id, role) values ('00000000-0000-0000-0000-0000000000b1', t.id('DD'), 'tenant_admin');
select t.run_as('F8a tenant_admin (authenticated no superadmin) NO puede crear comprobantes', 'authenticated',
  '00000000-0000-0000-0000-0000000000b1', format('select public.create_invoice_for_subscription(%L)', t.sub_of('Y')), false, 'Solo el superadmin%');
select t.run_as('F8b anon NO tiene EXECUTE sobre create_invoice_for_subscription', 'anon', null,
  format('select public.create_invoice_for_subscription(%L)', t.sub_of('Y')), false, '%permission denied%');
select t.run_as('F8c service_role SI puede (devuelve NULL por dedupe)', 'service_role', null,
  format('select public.create_invoice_for_subscription(%L)', t.sub_of('Y')), true);
