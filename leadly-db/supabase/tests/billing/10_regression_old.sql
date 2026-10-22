-- CODIGO VIGENTE (sin migraciones nuevas): demuestra los defectos que el arreglo corrige.
set client_min_messages = warning;
insert into public.profiles(id, tenant_id, role) values ('00000000-0000-0000-0000-0000000000a1', null, 'superadmin');
select t.tenant('REG');
select t.mk_inv(t.id('REG'), date '2020-01-01');
select t.chk('REG0 la prueba reproduce el estado: tenant activo con comprobante PENDING vencido hace anios',
  (select status from public.tenants where id = t.id('REG')) = 'active'
  and (select status from public.payment_invoices where payer_tenant_id = t.id('REG')) = 'PENDING');
-- El cron corre como postgres, sin claims: auth.uid() y auth.role() NULL.
select t.run_as('REG1 CODIGO VIEJO: el cron de mora FALLA con "Not authorized" (defecto D5 confirmado)',
  null, null, 'select public.deactivate_tenants_with_overdue_invoices()', false, '%Not authorized to change status%');
select t.chk('REG2 CODIGO VIEJO: al fallar se revierte tambien mark_overdue_invoices (sigue PENDING) y el tenant sigue activo',
  (select status from public.payment_invoices where payer_tenant_id = t.id('REG')) = 'PENDING'
  and (select status from public.tenants where id = t.id('REG')) = 'active');
-- primera factura: vence al FINAL del periodo, no hoy
insert into public.billing_plans(key, name, amount_cents, billing_interval) values ('zz_m', 'Zz mensual', 10000000, 'monthly');
select t.tenant('REG3');
insert into public.billing_subscriptions(tenant_id, plan_id) select t.id('REG3'), id from public.billing_plans where key = 'zz_m';
select t.chk('REG3 CODIGO VIEJO: la primera factura vence al FIN del periodo (due_date = hoy + 1 mes), no hoy',
  (select due_date from public.payment_invoices where payer_tenant_id = t.id('REG3')) = (current_date + interval '1 month')::date);
select t.chk('REG4 CODIGO VIEJO: payment_invoices no tiene period_start/period_end',
  not exists (select 1 from information_schema.columns where table_schema='public' and table_name='payment_invoices' and column_name in ('period_start','period_end')));
