-- Adopts the pattern proven in the sibling `lexy` project: ONE function
-- (create_invoice_for_subscription) creates the invoice for a subscription's
-- *current* period, called both when the subscription is first created and
-- by the renewal cron -- instead of duplicating the insert between a
-- first-invoice trigger and a separate cron loop, as this project had until
-- now. That in turn requires current_period_start/end to be known from the
-- moment a subscription is created (previously null until the first invoice
-- was paid) -- same as lexy's subscriptions table, where the period is
-- always defined regardless of payment status; payment just marks that
-- period's invoice PAID.

-- 1. Set the period immediately at creation if the caller didn't provide one
-- (assignTenantToPlan never does).
create or replace function public.billing_subscriptions_set_initial_period() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_interval interval;
begin
  if new.current_period_start is null or new.current_period_end is null then
    select case bp.billing_interval when 'monthly' then interval '1 month' when 'yearly' then interval '1 year' end
      into v_interval
    from public.billing_plans bp
    where bp.id = new.plan_id;

    new.current_period_start := coalesce(new.current_period_start, now());
    new.current_period_end := coalesce(new.current_period_end, new.current_period_start + v_interval);
  end if;
  return new;
end;
$$;

create trigger billing_subscriptions_set_initial_period
  before insert on public.billing_subscriptions
  for each row execute function public.billing_subscriptions_set_initial_period();

-- 2. The unified function. Dedupes by due_date = current_period_end (this
-- schema has no separate period_start/period_end columns on payment_invoices
-- like lexy's subscription_invoices does, so "an invoice already exists for
-- this period" is expressed as "an invoice already due on this period's end
-- date"). A $0 plan is born PAID and activates a PENDING_PAYMENT
-- subscription immediately, same as lexy.
create or replace function public.create_invoice_for_subscription(p_subscription_id uuid) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.billing_subscriptions;
  v_plan public.billing_plans;
  v_invoice_id uuid;
begin
  select * into v_sub from public.billing_subscriptions where id = p_subscription_id;
  if not found then
    raise exception 'billing_subscription % no existe', p_subscription_id;
  end if;

  select * into v_plan from public.billing_plans where id = v_sub.plan_id;
  if not found then
    return null;
  end if;

  if exists (
    select 1 from public.payment_invoices
    where subscription_id = p_subscription_id
    and due_date = v_sub.current_period_end::date
    and deleted_at is null
  ) then
    return null;
  end if;

  insert into public.payment_invoices (
    merchant_tenant_id, payer_tenant_id, subscription_id, provider_key,
    amount_cents, currency, status, invoice_number, description, due_date
  ) values (
    null, v_sub.tenant_id, p_subscription_id, 'wompi',
    v_plan.amount_cents, v_plan.currency,
    case when v_plan.amount_cents = 0 then 'PAID' else 'PENDING' end,
    'INV-' || to_char(now(), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6),
    v_plan.name, v_sub.current_period_end::date
  )
  returning id into v_invoice_id;

  insert into public.payment_invoice_items (invoice_id, description, quantity, unit_price_cents, subtotal_cents)
  values (v_invoice_id, v_plan.name, 1, v_plan.amount_cents, v_plan.amount_cents);

  if v_plan.amount_cents = 0 and v_sub.status = 'PENDING_PAYMENT' then
    update public.billing_subscriptions set status = 'ACTIVE' where id = p_subscription_id;
  end if;

  return v_invoice_id;
end;
$$;

-- 3. Replaces the old dedicated "first invoice" trigger with one that just
-- calls the unified function.
drop trigger if exists billing_subscriptions_create_initial_invoice on public.billing_subscriptions;
drop function if exists public.create_initial_invoice_for_subscription();

create or replace function public.billing_subscriptions_create_first_invoice() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.create_invoice_for_subscription(new.id);
  return new;
end;
$$;

create trigger billing_subscriptions_create_initial_invoice
  after insert on public.billing_subscriptions
  for each row execute function public.billing_subscriptions_create_first_invoice();

-- 4. Renewal cron: advances the period first (like lexy: "avanza periodos
-- vencidos y crea la factura del nuevo periodo"), then calls the same
-- unified function -- no more separate insert logic to keep in sync.
create or replace function public.process_recurring_billing_invoices() returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub record;
  v_interval interval;
begin
  update public.billing_subscriptions
  set status = 'CANCELLED', cancelled_at = now()
  where status = 'ACTIVE'
  and cancel_at_period_end = true
  and current_period_end is not null
  and current_period_end <= now();

  for v_sub in
    select bs.id, bp.billing_interval
    from public.billing_subscriptions bs
    join public.billing_plans bp on bp.id = bs.plan_id
    where bs.status = 'ACTIVE'
    and bs.cancel_at_period_end = false
    and bs.current_period_end is not null
    and bs.current_period_end <= now() + interval '3 days'
  loop
    v_interval := case v_sub.billing_interval when 'monthly' then interval '1 month' when 'yearly' then interval '1 year' end;

    update public.billing_subscriptions
    set current_period_start = current_period_end,
        current_period_end = current_period_end + v_interval
    where id = v_sub.id;

    perform public.create_invoice_for_subscription(v_sub.id);
  end loop;
end;
$$;
