-- Correccion de DATOS: fechas de la suscripcion Enterprise de Moyano.
-- Contrato: progress/brief_correccion_suscripciones.md. NO cambia esquema ni funciones.
-- Aplicar DESPUES de 20261013180000 (fix del doble avance del periodo).
--
-- Instruccion del usuario: "factura desde el lunes de la semana pasada
-- (2026-10-05), que venza esa misma fecha del mes siguiente (2026-11-05)".
-- Hoy la suscripcion quedo con el periodo adelantado un mes de mas por el doble
-- avance del trigger anterior: [2026-11-13, 2026-12-13] (creada 2026-10-13).
--
-- Cambia SOLO fechas (monto 40000000, estado PAID, plan, modulos e intento de
-- pago manual no se tocan en valor):
--   suscripcion: current_period_start/end, created_at, setup_fee_billed_at
--   factura:     due_date, created_at, invoice_number (INV-20261005-*)
--   intento:     created_at
-- Triggers (leidos): payment_invoices_set_updated_at (BEFORE UPDATE, solo
-- updated_at); snapshot_invoice_buyer_and_tax es BEFORE INSERT (no corre);
-- activate_subscription_on_invoice_paid solo actua si status pasa a PAID (aqui
-- no cambia); billing_subscriptions_sync_modules_upd solo dispara por
-- plan_id/status (no cambian). payment_attempts no tiene triggers.
-- Aborta SIN escribir si el estado difiere; idempotente.
do $$
declare
  c_tenant constant uuid := '7419c825-4d72-45af-bf40-73375eed9f9c';
  c_sub constant uuid := '5a79e4bb-3ede-4b83-8966-014ec0b4aa15';
  c_inv constant uuid := 'b596941e-798b-4e77-97ed-00ea681c56a0';
  c_start constant timestamptz := '2026-10-05 00:00:00-05';
  c_end constant timestamptz := '2026-11-05 00:00:00-05';
  c_due constant date := date '2026-11-05';
  c_old_start constant timestamptz := '2026-11-13 04:34:08+00';
  c_old_end constant timestamptz := '2026-12-13 04:34:08+00';
  v_sub public.billing_subscriptions;
  v_inv public.payment_invoices;
  v_n integer;
begin
  select * into v_sub from public.billing_subscriptions where id = c_sub;
  if not found then
    raise exception 'correct_moyano_subscription_dates: la suscripcion % no existe; no se escribe nada', c_sub;
  end if;
  if v_sub.tenant_id <> c_tenant then
    raise exception 'correct_moyano_subscription_dates: la suscripcion pertenece al tenant %, no a Moyano; no se escribe nada', v_sub.tenant_id;
  end if;

  select * into v_inv from public.payment_invoices where id = c_inv;
  if not found then
    raise exception 'correct_moyano_subscription_dates: la factura % no existe; no se escribe nada', c_inv;
  end if;
  if v_inv.payer_tenant_id is distinct from c_tenant or v_inv.subscription_id is distinct from c_sub then
    raise exception 'correct_moyano_subscription_dates: la factura no es de la suscripcion/tenant de Moyano; no se escribe nada';
  end if;

  select count(*) into v_n from public.payment_invoices where subscription_id = c_sub;
  if v_n <> 1 then
    raise exception 'correct_moyano_subscription_dates: la suscripcion tiene % facturas, se esperaba 1; no se escribe nada', v_n;
  end if;
  if v_inv.amount_cents <> 40000000 then
    raise exception 'correct_moyano_subscription_dates: la factura es de % centavos, se esperaba 40000000; no se escribe nada', v_inv.amount_cents;
  end if;
  if v_inv.status <> 'PAID' then
    raise exception 'correct_moyano_subscription_dates: la factura esta en estado %, se esperaba PAID; no se escribe nada', v_inv.status;
  end if;
  select count(*) into v_n from public.payment_attempts where invoice_id = c_inv;
  if v_n <> 1 then
    raise exception 'correct_moyano_subscription_dates: la factura tiene % intentos de pago, se esperaba 1; no se escribe nada', v_n;
  end if;

  -- Ya aplicada.
  if v_sub.current_period_start = c_start and v_sub.current_period_end = c_end
     and v_sub.created_at = c_start and v_sub.setup_fee_billed_at = c_start
     and v_inv.due_date = c_due and v_inv.created_at = c_start
     and v_inv.invoice_number like 'INV-20261005-%'
     and not exists (select 1 from public.payment_attempts where invoice_id = c_inv and created_at <> c_start) then
    raise notice 'correct_moyano_subscription_dates: ya aplicada; nada que hacer';
    return;
  end if;

  -- Produccion guarda microsegundos (04:34:08.207366); se compara a segundos.
  if date_trunc('second', v_sub.current_period_start) is distinct from c_old_start
     or date_trunc('second', v_sub.current_period_end) is distinct from c_old_end then
    raise exception 'correct_moyano_subscription_dates: el periodo actual es [%, %], se esperaba [%, %]; no se escribe nada',
      v_sub.current_period_start, v_sub.current_period_end, c_old_start, c_old_end;
  end if;

  update public.billing_subscriptions
     set current_period_start = c_start,
         current_period_end = c_end,
         created_at = c_start,
         setup_fee_billed_at = c_start
   where id = c_sub;

  update public.payment_invoices
     set due_date = c_due,
         created_at = c_start,
         invoice_number = regexp_replace(invoice_number, '^INV-[0-9]{8}-', 'INV-20261005-')
   where id = c_inv;

  update public.payment_attempts set created_at = c_start where invoice_id = c_inv;

  -- Verificacion posterior: nada mas cambio.
  select * into v_inv from public.payment_invoices where id = c_inv;
  select * into v_sub from public.billing_subscriptions where id = c_sub;
  if v_inv.amount_cents <> 40000000 or v_inv.status <> 'PAID' or v_sub.status <> 'ACTIVE'
     or v_inv.due_date <> c_due or v_sub.current_period_end <> c_end then
    raise exception 'correct_moyano_subscription_dates: el estado final no es el esperado';
  end if;

  raise notice 'correct_moyano_subscription_dates: aplicada (periodo [2026-10-05, 2026-11-05], factura due 2026-11-05)';
end
$$;
