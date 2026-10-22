-- ST4 / D9 (DATOS, una sola fila): el comprobante pendiente de Barriles de la sexta (periodo 10-oct -> 10-nov)
-- pasa a vencer el 10-oct, como pide el cobro anticipado. Decision explicita del usuario: queda en mora y el cron
-- horario (deactivate_tenants_with_overdue_invoices) lo bloqueara con suspension_reason='nonpayment'; al registrar
-- el pago manual se reactiva solo. Esta migracion NO toca tenants, suscripciones ni otros comprobantes.
--
-- Guardas EXACTAS (el estado verificado en la base real el 2026-10-20):
--   * el comprobante no existe                         -> no-op con NOTICE
--   * ya tiene due_date = 2026-10-10                   -> no-op con NOTICE
--   * cualquier otro estado distinto de lo esperado    -> ABORTA (no se adivina)
do $$
declare
  c_inv    constant uuid := '5851bd75-6fd7-4ae8-bae6-f2ec705e9010';
  c_tenant constant uuid := '9c79437d-1c19-4edc-bc1f-0dc06094823a';
  v_inv record;
  v_sub record;
  v_n integer;
begin
  select * into v_inv from public.payment_invoices where id = c_inv;
  if not found then
    raise notice 'barriles_prepaid_due_date: el comprobante % no existe; no-op', c_inv;
    return;
  end if;
  if v_inv.due_date = date '2026-10-10' then
    raise notice 'barriles_prepaid_due_date: el comprobante % ya vence 2026-10-10; no-op', c_inv;
    return;
  end if;

  if v_inv.payer_tenant_id is distinct from c_tenant
     or v_inv.status <> 'PENDING'
     or v_inv.deleted_at is not null
     or v_inv.amount_cents <> 14000000
     or v_inv.period_start is distinct from date '2026-10-10'
     or v_inv.period_end is distinct from date '2026-11-10'
     or v_inv.due_date is distinct from date '2026-11-10'
     or v_inv.subscription_id is null then
    raise exception 'barriles_prepaid_due_date: el comprobante % no esta en el estado esperado (tenant=%, status=%, deleted_at=%, amount=%, periodo=[%,%], due=%); se aborta sin cambios',
      c_inv, v_inv.payer_tenant_id, v_inv.status, v_inv.deleted_at, v_inv.amount_cents, v_inv.period_start, v_inv.period_end, v_inv.due_date;
  end if;

  select * into v_sub from public.billing_subscriptions where id = v_inv.subscription_id;
  if not found
     or v_sub.tenant_id is distinct from c_tenant
     or v_sub.status <> 'ACTIVE'
     or not ((v_sub.current_period_start at time zone 'UTC')::date = date '2026-10-10'
             or (v_sub.current_period_start at time zone 'America/Bogota')::date = date '2026-10-10')
     or not ((v_sub.current_period_end at time zone 'UTC')::date = date '2026-11-10'
             or (v_sub.current_period_end at time zone 'America/Bogota')::date = date '2026-11-10') then
    raise exception 'barriles_prepaid_due_date: la suscripcion % del comprobante no esta ACTIVE con periodo [2026-10-10, 2026-11-10] de Barriles; se aborta sin cambios', v_inv.subscription_id;
  end if;

  update public.payment_invoices
  set due_date = date '2026-10-10'
  where id = c_inv and status = 'PENDING' and deleted_at is null and due_date = date '2026-11-10';
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'barriles_prepaid_due_date: se esperaba actualizar 1 fila y fueron %', v_n;
  end if;
  raise notice 'barriles_prepaid_due_date: comprobante % ahora vence 2026-10-10', c_inv;
end $$;
