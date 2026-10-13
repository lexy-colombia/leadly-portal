-- Elimina 5 facturas de suscripcion FALSAS de public.payment_invoices.
--
-- Por que: son facturas de prueba (cobro de Lexy a un comercio por su
-- suscripcion "Plan Starter", COP 199.000) del tenant de pruebas TecnoNova
-- (cb195047-8cd2-4e38-9964-62bb99911814). Ninguna tiene provider_checkout_id ni
-- provider_transaction_id (cero movimiento real de Wompi); las dos PAID se
-- marcaron a mano. Pedido explicito del usuario (2026-10-13).
--
-- Ids (fijados, nunca por criterio amplio):
--   c22b2fca-6ebf-47cb-bfdf-646494519626 (PAID)
--   9334c37a-e043-474b-815c-3e3aefd99096 (PAID)
--   b958f0fd-ad57-4f82-b03b-b3ba6098f3d0 (OVERDUE)
--   10a84093-dba1-4e41-ac5f-e624d051c368 (PENDING)
--   b4bb8fdd-9b70-4913-bc23-48fabcd0e5b9 (PENDING)
--
-- Hijos que caen por ON DELETE CASCADE: payment_invoice_items y payment_attempts.
-- payment_invoices no tiene triggers de DELETE (no se dispara
-- activate_subscription_on_invoice_paid).
--
-- NO se tocan: billing_subscriptions (siguen ACTIVE; el cron de facturacion
-- recurrente se basa en current_period_end, no en la existencia de facturas),
-- ni sales_invoices (facturas DIAN), ni ninguna otra fila de payment_invoices.
--
-- Idempotente. Aborta sin borrar nada si algun id existente no cumple las
-- condiciones de "factura falsa" (tenant, monto, sin rastro de proveedor).
do $$
declare
  v_ids constant uuid[] := array[
    'c22b2fca-6ebf-47cb-bfdf-646494519626',
    '9334c37a-e043-474b-815c-3e3aefd99096',
    'b958f0fd-ad57-4f82-b03b-b3ba6098f3d0',
    '10a84093-dba1-4e41-ac5f-e624d051c368',
    'b4bb8fdd-9b70-4913-bc23-48fabcd0e5b9'
  ]::uuid[];
  v_tenant constant uuid := 'cb195047-8cd2-4e38-9964-62bb99911814';
  v_amount constant integer := 19900000;
  v_found int;
  v_bad int;
  v_items int;
  v_attempts int;
  v_deleted int;
begin
  select count(*) into v_found from public.payment_invoices where id = any(v_ids);
  if v_found = 0 then
    raise notice 'delete_fake_subscription_invoices: ninguna de las 5 facturas existe; nada que hacer';
    return;
  end if;

  select count(*) into v_bad
  from public.payment_invoices
  where id = any(v_ids)
    and (payer_tenant_id is distinct from v_tenant
         or amount_cents is distinct from v_amount
         or provider_transaction_id is not null
         or provider_checkout_id is not null);
  if v_bad > 0 then
    raise exception 'delete_fake_subscription_invoices: % factura(s) no cumplen las condiciones de factura falsa (tenant/monto/provider_*); no se borra nada', v_bad;
  end if;

  select count(*) into v_bad
  from public.payment_attempts
  where invoice_id = any(v_ids) and provider_transaction_id is not null;
  if v_bad > 0 then
    raise exception 'delete_fake_subscription_invoices: % intento(s) de pago con provider_transaction_id; son pagos reales, no se borra nada', v_bad;
  end if;

  select count(*) into v_items from public.payment_invoice_items where invoice_id = any(v_ids);
  select count(*) into v_attempts from public.payment_attempts where invoice_id = any(v_ids);

  delete from public.payment_invoices where id = any(v_ids);
  get diagnostics v_deleted = row_count;

  raise notice 'delete_fake_subscription_invoices: eliminadas % factura(s), % item(s), % intento(s) de pago', v_deleted, v_items, v_attempts;
end
$$;
