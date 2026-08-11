-- Recurring billing: mirrors the `lexy` pattern (Wompi itself only does
-- one-off Payment Links, recurrence lives entirely in our own DB via
-- pg_cron, not in the provider). For each ACTIVE subscription approaching
-- (or past) its period end with no open invoice already pending, create the
-- next payment_invoices row -- merchant_tenant_id null because Leadly is the
-- merchant in this, the only consumer of billing_subscriptions today.
create or replace function public.process_recurring_billing_invoices() returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub record;
begin
  for v_sub in
    select bs.id, bs.tenant_id, bp.id as plan_id, bp.amount_cents, bp.currency
    from public.billing_subscriptions bs
    join public.billing_plans bp on bp.id = bs.plan_id
    where bs.status = 'ACTIVE'
    and bs.current_period_end is not null
    and bs.current_period_end <= now() + interval '3 days'
    and not exists (
      select 1 from public.payment_invoices pi
      where pi.subscription_id = bs.id and pi.status = 'PENDING' and pi.deleted_at is null
    )
  loop
    insert into public.payment_invoices (
      merchant_tenant_id, payer_tenant_id, subscription_id, provider_key,
      amount_cents, currency, status, invoice_number, due_date
    ) values (
      null, v_sub.tenant_id, v_sub.id, 'wompi',
      v_sub.amount_cents, v_sub.currency, 'PENDING',
      'INV-' || to_char(now(), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6),
      v_sub.current_period_end::date
    );
  end loop;
end;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process_recurring_billing_invoices') THEN
    PERFORM cron.schedule(
      'process_recurring_billing_invoices',
      '0 7 * * *',
      'SELECT public.process_recurring_billing_invoices()'
    );
  END IF;
EXCEPTION
  WHEN undefined_object THEN
    NULL;
END;
$$;
