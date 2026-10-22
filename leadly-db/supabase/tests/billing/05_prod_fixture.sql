-- Estado "produccion" ANTES de las migraciones nuevas, construido con el codigo VIGENTE
-- (create_invoice_for_subscription de 1 argumento: due_date = fin del periodo):
--  Barriles: Enterprise a la medida ACTIVE [2026-10-10, 2026-11-10]; comprobantes PAID (due 10-10, id
--            generado) y PENDING (due 11-10, id 5851bd75-...).
--  Faiver:   Enterprise a la medida ACTIVE [2026-10-05, 2026-11-05]; comprobante PAID (due 11-05).
set client_min_messages = warning;
insert into public.profiles(id, tenant_id, role) values ('00000000-0000-0000-0000-0000000000a1', null, 'superadmin');
insert into public.billing_plans(key, name, amount_cents, billing_interval, is_custom, setup_fee_cents)
  values ('zz_ent', 'Enterprise', 0, 'monthly', true, 0);
insert into public.tenants(id, name, status) values
  ('9c79437d-1c19-4edc-bc1f-0dc06094823a', 'Barriles de la sexta', 'active'),
  ('5a1e0000-0000-4000-8000-000000000002', 'Faiver Andres', 'active');
insert into t.ids values ('BAR', '9c79437d-1c19-4edc-bc1f-0dc06094823a'), ('FAI', '5a1e0000-0000-4000-8000-000000000002');

-- Barriles: nace con el periodo historico; el trigger AFTER INSERT crea el comprobante (codigo viejo: due = fin = 10-10)
insert into public.billing_subscriptions(id, tenant_id, plan_id, status, current_period_start, current_period_end,
    custom_base_amount_cents, setup_fee_override_cents, setup_fee_billed_at, cancel_at_period_end, created_at)
select 'b0b0b0b0-0000-4000-8000-000000000001', t.id('BAR'), id, 'ACTIVE', '2026-09-10 00:00:00-05', '2026-10-10 00:00:00-05',
       14000000, 0, '2026-09-10 00:00:00-05', false, '2026-09-10 00:00:00-05'
from public.billing_plans where key = 'zz_ent';
insert into public.billing_subscription_modules(subscription_id, module_key, price_cents, note)
  values ('b0b0b0b0-0000-4000-8000-000000000001', 'sales', 0, 'Incluido sin costo'),
         ('b0b0b0b0-0000-4000-8000-000000000001', 'reports', 0, 'Incluido sin costo');
update public.payment_invoices set status = 'PAID' where subscription_id = 'b0b0b0b0-0000-4000-8000-000000000001';
update public.billing_subscriptions set current_period_start = '2026-10-10 00:00:00-05', current_period_end = '2026-11-10 00:00:00-05'
  where id = 'b0b0b0b0-0000-4000-8000-000000000001';
select public.create_invoice_for_subscription('b0b0b0b0-0000-4000-8000-000000000001') is not null as creada;
-- el id real del comprobante pendiente de Barriles (la migracion lo verifica); renombrar sin disparar FK/triggers
do $$
declare v_old uuid;
begin
  select id into v_old from public.payment_invoices where subscription_id = 'b0b0b0b0-0000-4000-8000-000000000001' and status = 'PENDING';
  set local session_replication_role = replica;
  update public.payment_invoice_items set invoice_id = '5851bd75-6fd7-4ae8-bae6-f2ec705e9010' where invoice_id = v_old;
  update public.payment_invoices set id = '5851bd75-6fd7-4ae8-bae6-f2ec705e9010' where id = v_old;
  set local session_replication_role = origin;
end $$;

-- Faiver
insert into public.billing_subscriptions(id, tenant_id, plan_id, status, current_period_start, current_period_end,
    custom_base_amount_cents, setup_fee_override_cents, setup_fee_billed_at, cancel_at_period_end, created_at)
select 'fa1fa1fa-0000-4000-8000-000000000001', t.id('FAI'), id, 'ACTIVE', '2026-10-05 00:00:00-05', '2026-11-05 00:00:00-05',
       14000000, 0, '2026-10-05 00:00:00-05', false, '2026-10-05 00:00:00-05'
from public.billing_plans where key = 'zz_ent';
update public.payment_invoices set status = 'PAID' where subscription_id = 'fa1fa1fa-0000-4000-8000-000000000001';
