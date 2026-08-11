-- Mirrors the trigger used in the `lexy` project (invoice PAID -> activate
-- subscription): keeps activation logic in one place (the DB) instead of
-- duplicating it across payment-webhook-wompi and sync-payment-invoices.
create or replace function public.activate_subscription_on_invoice_paid() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_interval interval;
begin
  if new.status = 'PAID' and old.status is distinct from 'PAID' and new.subscription_id is not null then
    select case bp.billing_interval
             when 'monthly' then interval '1 month'
             when 'yearly' then interval '1 year'
           end
      into v_interval
    from public.billing_subscriptions bs
    join public.billing_plans bp on bp.id = bs.plan_id
    where bs.id = new.subscription_id;

    update public.billing_subscriptions
    set status = 'ACTIVE',
        current_period_start = coalesce(current_period_end, now()),
        current_period_end = coalesce(current_period_end, now()) + v_interval
    where id = new.subscription_id;
  end if;
  return new;
end;
$$;

create trigger payment_invoices_activate_subscription
  after update on public.payment_invoices
  for each row execute function public.activate_subscription_on_invoice_paid();
