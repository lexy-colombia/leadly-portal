-- Cancelling a subscription used to flip it to CANCELLED immediately --
-- wrong: like Netflix/Amazon, a tenant that cancels should stay usable
-- until the period they already paid for ends, and simply not renew after
-- that. `cancel_at_period_end` is the flag; status keeps meaning "is this
-- usable right now" and stays ACTIVE until the period actually runs out.
alter table public.billing_subscriptions
  add column cancel_at_period_end boolean not null default false;

comment on column public.billing_subscriptions.cancel_at_period_end is 'Marcada al cancelar: la suscripción sigue ACTIVE hasta current_period_end, luego el cron la pasa a CANCELLED y deja de generar la próxima factura.';

-- Cancelling a subscription that's already usable for a paid, in-progress
-- period only schedules the cancellation; one that never got a period going
-- (PENDING_PAYMENT, or somehow past its own end date already) has nothing
-- left to honor, so it cancels immediately -- same distinction Stripe makes.
create or replace function public.cancel_subscription(p_subscription_id uuid) returns public.billing_subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.billing_subscriptions;
begin
  if not public.is_superadmin() then
    raise exception 'Solo el superadmin puede cancelar una suscripción';
  end if;

  select * into v_sub from public.billing_subscriptions where id = p_subscription_id;
  if not found then
    raise exception 'Suscripción no encontrada';
  end if;

  if v_sub.status = 'ACTIVE' and v_sub.current_period_end is not null and v_sub.current_period_end > now() then
    update public.billing_subscriptions
    set cancel_at_period_end = true
    where id = p_subscription_id
    returning * into v_sub;
  else
    update public.billing_subscriptions
    set status = 'CANCELLED', cancelled_at = now(), cancel_at_period_end = false
    where id = p_subscription_id
    returning * into v_sub;
  end if;

  return v_sub;
end;
$$;

revoke execute on function public.cancel_subscription(uuid) from public, anon;
grant execute on function public.cancel_subscription(uuid) to authenticated;

-- Undo a scheduled cancellation before the period runs out.
create or replace function public.reactivate_subscription(p_subscription_id uuid) returns public.billing_subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.billing_subscriptions;
begin
  if not public.is_superadmin() then
    raise exception 'Solo el superadmin puede reactivar una suscripción';
  end if;

  update public.billing_subscriptions
  set cancel_at_period_end = false
  where id = p_subscription_id and status = 'ACTIVE' and cancel_at_period_end = true
  returning * into v_sub;

  if not found then
    raise exception 'Esta suscripción no tiene una cancelación pendiente';
  end if;

  return v_sub;
end;
$$;

revoke execute on function public.reactivate_subscription(uuid) from public, anon;
grant execute on function public.reactivate_subscription(uuid) to authenticated;

-- The cron now also finalizes subscriptions whose paid period ran out with
-- cancel_at_period_end set, and skips renewal invoices for any subscription
-- scheduled to cancel (even a few days before its period actually ends).
create or replace function public.process_recurring_billing_invoices() returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub record;
  v_invoice_id uuid;
begin
  update public.billing_subscriptions
  set status = 'CANCELLED', cancelled_at = now()
  where status = 'ACTIVE'
  and cancel_at_period_end = true
  and current_period_end is not null
  and current_period_end <= now();

  for v_sub in
    select bs.id, bs.tenant_id, bp.id as plan_id, bp.name as plan_name, bp.amount_cents, bp.currency
    from public.billing_subscriptions bs
    join public.billing_plans bp on bp.id = bs.plan_id
    where bs.status = 'ACTIVE'
    and bs.cancel_at_period_end = false
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
