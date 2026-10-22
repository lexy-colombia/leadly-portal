-- Cobro anticipado de suscripciones, parte 2: ciclo en dos pasos (D3).
-- Plan: progress/feature_billing_prepaid.md.
--
-- Antes: el cron diario (07:00) avanzaba el periodo hasta 3 dias antes de que
-- terminara y facturaba el periodo NUEVO, con vencimiento al final de ese periodo.
-- Ahora, sin mover el periodo al emitir:
--   1. EMITIR: a toda suscripcion ACTIVE (sin cancelar al final del periodo) cuyo
--      periodo vigente termina dentro del adelanto (7 dias mensual / 30 anual) se
--      le emite el comprobante del periodo SIGUIENTE (empieza en current_period_end),
--      que vence el dia que empieza. El dedupe por (subscription_id, period_start)
--      de create_invoice_for_subscription lo hace idempotente.
--   2. AVANZAR: cuando el periodo vigente ya termino (current_period_end <= now()),
--      se avanza un intervalo (current_period_start = fin anterior). Luego se llama
--      a create_invoice_for_subscription con el inicio del periodo recien vigente:
--      normalmente es un no-op por el dedupe (ya se emitio en el paso 1) y solo
--      actua como red de seguridad si ese comprobante nunca se emitio (cron caido,
--      suscripcion con periodo historico), para no omitir un periodo.
-- Razon de no avanzar al emitir: con un adelanto de 30 dias (anual) el periodo
-- vigente quedaria con current_period_start en el futuro.
--
-- Se conserva: el paso de CANCEL previo (ACTIVE con cancel_at_period_end vencida ->
-- CANCELLED) y el bloque EXCEPTION por suscripcion (una mala no aborta el lote; se
-- reintenta al dia siguiente). Un avance de periodo por corrida, como antes.
-- H1 (review ST1): como ahora se emite ANTES de que termine el periodo, cancelar dentro de
-- la ventana de 7/30 dias dejaba un comprobante PENDING del periodo siguiente que, al vencer
-- + 3 dias, bloqueaba por mora a un cliente que ya cancelo (y pagarlo no reactiva la
-- suscripcion). annul_future_invoices(sub) anula (soft-delete: deleted_at/deleted_by, nunca
-- DELETE) los comprobantes PENDING/OVERDUE con period_start >= fin del periodo vigente;
-- no toca el periodo vigente ni los PAID. Lo llaman cancel_subscription (ambas ramas:
-- programar la cancelacion e inmediata) y el paso CANCEL del cron. Reanudar
-- (reactivate_subscription) no necesita cambios: al estar el comprobante anulado con
-- deleted_at el indice unico parcial libera el periodo y el cron lo vuelve a emitir solo si
-- cae en la ventana (sin hueco ni duplicado).
-- Privilegios: create or replace conserva el ACL; se reafirma el de 20261013140000
-- (solo service_role/owner).

create or replace function public.annul_future_invoices(p_subscription_id uuid) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_end date;
  v_n integer;
begin
  select current_period_end::date into v_end from public.billing_subscriptions where id = p_subscription_id;
  if v_end is null then
    return 0;
  end if;
  update public.payment_invoices
  set deleted_at = now(), deleted_by = auth.uid()
  where subscription_id = p_subscription_id
  and deleted_at is null
  and status in ('PENDING', 'OVERDUE')
  and period_start is not null
  and period_start >= v_end;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke execute on function public.annul_future_invoices(uuid) from public, anon, authenticated;
grant execute on function public.annul_future_invoices(uuid) to service_role;

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

  perform public.annul_future_invoices(p_subscription_id); -- H1

  return v_sub;
end;
$$;

revoke execute on function public.cancel_subscription(uuid) from public, anon;
grant execute on function public.cancel_subscription(uuid) to authenticated;

create or replace function public.process_recurring_billing_invoices() returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub record;
  v_interval interval;
  v_new_start timestamptz;
  v_cancelled uuid[];
  v_id uuid;
begin
  with c as (
    update public.billing_subscriptions
    set status = 'CANCELLED', cancelled_at = now()
    where status = 'ACTIVE'
    and cancel_at_period_end = true
    and current_period_end is not null
    and current_period_end <= now()
    returning id
  )
  select array_agg(id) into v_cancelled from c;
  -- H1: una cancelacion programada que llega a su fin no deja comprobantes futuros vivos.
  foreach v_id in array coalesce(v_cancelled, array[]::uuid[]) loop
    perform public.annul_future_invoices(v_id); -- H1-cron
  end loop;

  -- 1. Emitir el comprobante del periodo siguiente (sin avanzar el periodo).
  for v_sub in
    select bs.id, bs.current_period_end
    from public.billing_subscriptions bs
    join public.billing_plans bp on bp.id = bs.plan_id
    where bs.status = 'ACTIVE'
    and bs.cancel_at_period_end = false
    and bs.current_period_end is not null
    and bs.current_period_end <= now() + case bp.billing_interval
                                           when 'yearly' then interval '30 days'
                                           else interval '7 days' end
  loop
    begin
      perform public.create_invoice_for_subscription(v_sub.id, v_sub.current_period_end::date);
    exception when others then
      raise warning 'process_recurring_billing_invoices: emision de la suscripcion % omitida (se reintenta mañana): %', v_sub.id, sqlerrm;
    end;
  end loop;

  -- 2. Avanzar el periodo de las que ya terminaron.
  for v_sub in
    select bs.id, bp.billing_interval
    from public.billing_subscriptions bs
    join public.billing_plans bp on bp.id = bs.plan_id
    where bs.status = 'ACTIVE'
    and bs.cancel_at_period_end = false
    and bs.current_period_end is not null
    and bs.current_period_end <= now()
  loop
    begin
      v_interval := case v_sub.billing_interval when 'yearly' then interval '1 year' else interval '1 month' end;

      update public.billing_subscriptions
      set current_period_start = current_period_end,
          current_period_end = current_period_end + v_interval
      where id = v_sub.id
      returning current_period_start into v_new_start;

      perform public.create_invoice_for_subscription(v_sub.id, v_new_start::date);
    exception when others then
      raise warning 'process_recurring_billing_invoices: avance de la suscripcion % omitido (se reintenta mañana): %', v_sub.id, sqlerrm;
    end;
  end loop;
end;
$$;

revoke execute on function public.process_recurring_billing_invoices() from public, anon, authenticated;
grant execute on function public.process_recurring_billing_invoices() to service_role;
