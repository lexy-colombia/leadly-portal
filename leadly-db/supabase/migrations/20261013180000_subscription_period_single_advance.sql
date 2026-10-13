-- Corrige el DOBLE AVANCE del periodo de suscripcion (billing recurrente).
--
-- Defecto: activate_subscription_on_invoice_paid() (20260807173621) corre cuando
-- una factura pasa a PAID y movia el periodo SIEMPRE (+1 intervalo desde
-- current_period_end), aunque la suscripcion ya estuviera ACTIVE. Pero desde
-- 20260811000011 el cron process_recurring_billing_invoices() YA avanza el
-- periodo antes de facturar cada ciclo. Resultado: el periodo avanzaba dos veces
-- por ciclo (cron + pago) y, con el tiempo, el cron saltaba facturas mensuales
-- en silencio (ingreso perdido). Ej.: periodo [10-10, 11-10]; cron 11-07 ->
-- [11-10, 12-10] + factura due 12-10; el cliente paga la de 11-10 -> el trigger
-- lo lleva a [12-10, 01-10]; los crons de 12-07 y 01-07 no hacen nada.
--
-- Regla nueva: SOLO el cron avanza el periodo de una suscripcion ACTIVE. El
-- pago unicamente activa:
--   * PENDING_PAYMENT / PAST_DUE -> ACTIVE. El periodo NO se mueve si
--     current_period_end ya existe (lo fijo el alta: set_initial_period o el
--     reinicio de create_invoice_for_subscription). Si es NULL (legado), se
--     fija [now(), now() + intervalo], como antes.
--   * ACTIVE -> no se toca nada (ni status ni periodo).
--   * CANCELLED / EXPIRED -> no se reactiva ni se mueve nada (antes un pago
--     reactivaba cualquier estado, incluso CANCELLED; ahora una suscripcion
--     cancelada requiere una accion explicita de reasignacion de plan).
--
-- create or replace conserva owner, security definer, search_path y los
-- privilegios (revoke de 20260807173703); no se otorga nada nuevo. No toca
-- tenants: reactivar el comercio tras pagar sigue siendo manual. record_manual_payment
-- y el webhook de Wompi solo marcan la factura PAID; este trigger los cubre sin cambios.
-- Sin migracion de datos: un periodo ya adelantado en produccion (p.ej. Moyano,
-- [2026-11-13, 2026-12-13]) NO se corrige aqui.
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
             when 'yearly' then interval '1 year'
             else interval '1 month'
           end
      into v_interval
    from public.billing_subscriptions bs
    join public.billing_plans bp on bp.id = bs.plan_id
    where bs.id = new.subscription_id;

    update public.billing_subscriptions
    set status = 'ACTIVE',
        current_period_start = case when current_period_end is null then now() else current_period_start end,
        current_period_end = case when current_period_end is null then now() + coalesce(v_interval, interval '1 month') else current_period_end end
    where id = new.subscription_id
      and status in ('PENDING_PAYMENT', 'PAST_DUE');
  end if;
  return new;
end;
$$;
