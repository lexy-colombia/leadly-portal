-- Real bug: process_recurring_billing_invoices() only ever looks at
-- status = 'ACTIVE' subscriptions whose period is ending -- a brand new
-- subscription starts as PENDING_PAYMENT with no period dates at all, so it
-- was NEVER picked up by anything. Assigning a plan left the tenant stuck
-- showing "pendiente de pago" with no invoice ever generated to pay.
-- This trigger creates that first invoice (+ its one line item) the moment
-- a subscription is created, exactly the way the cron creates renewal
-- invoices for later periods -- activate_subscription_on_invoice_paid then
-- picks it up identically whether it's paid via Wompi or a manual payment.
create or replace function public.create_initial_invoice_for_subscription() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan record;
  v_invoice_id uuid;
  v_due_date date;
begin
  select name, amount_cents, currency into v_plan
  from public.billing_plans
  where id = new.plan_id;

  -- No paid plan (free/$0, or plan missing) -- nothing to invoice.
  if v_plan is null or v_plan.amount_cents <= 0 then
    return new;
  end if;

  v_due_date := (now() + interval '5 days')::date;

  insert into public.payment_invoices (
    merchant_tenant_id, payer_tenant_id, subscription_id, provider_key,
    amount_cents, currency, status, invoice_number, description, due_date
  ) values (
    null, new.tenant_id, new.id, 'wompi',
    v_plan.amount_cents, v_plan.currency, 'PENDING',
    'INV-' || to_char(now(), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6),
    v_plan.name, v_due_date
  )
  returning id into v_invoice_id;

  insert into public.payment_invoice_items (invoice_id, description, quantity, unit_price_cents, subtotal_cents)
  values (v_invoice_id, v_plan.name, 1, v_plan.amount_cents, v_plan.amount_cents);

  return new;
end;
$$;

create trigger billing_subscriptions_create_initial_invoice
  after insert on public.billing_subscriptions
  for each row execute function public.create_initial_invoice_for_subscription();

-- Same treatment for renewal invoices: insert the matching line item so
-- every invoice (first period or a renewal) carries at least one item.
create or replace function public.process_recurring_billing_invoices() returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub record;
  v_invoice_id uuid;
begin
  for v_sub in
    select bs.id, bs.tenant_id, bp.id as plan_id, bp.name as plan_name, bp.amount_cents, bp.currency
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
      amount_cents, currency, status, invoice_number, description, due_date
    ) values (
      null, v_sub.tenant_id, v_sub.id, 'wompi',
      v_sub.amount_cents, v_sub.currency, 'PENDING',
      'INV-' || to_char(now(), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6),
      v_sub.plan_name, v_sub.current_period_end::date
    )
    returning id into v_invoice_id;

    insert into public.payment_invoice_items (invoice_id, description, quantity, unit_price_cents, subtotal_cents)
    values (v_invoice_id, v_sub.plan_name, 1, v_sub.amount_cents, v_sub.amount_cents);
  end loop;
end;
$$;
