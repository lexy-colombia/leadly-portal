-- ST3 (feature Wompi unificado): funciones que acreditan, en UNA transaccion, un
-- pago aprobado informado por el aviso firmado de payments-api al consumidor
-- interno de Leadly (Edge Function payments-internal).
--
--   apply_wompi_order_payment(...)   -> INSERT en public.sales_order_payments
--   apply_wompi_invoice_payment(...) -> factura de plataforma PENDING/OVERDUE -> PAID
--                                       + payment_attempts (misma semantica que
--                                       applyWebhookEvent.ts con atomicClaim)
--
-- Idempotencia (sin tabla nueva de eventos): la dan los indices unicos YA aplicados
--   sales_order_payments_payment_link_idx        (un pago por link del servicio)
--   sales_order_payments_wompi_transaction_uidx  (una transaccion = un pago)
--   payment_invoices_provider_transaction_uidx   (una transaccion = una factura)
-- y el estado del destino (factura ya PAID). Una reentrega del MISMO evento
-- devuelve 'duplicate'; una colision que NO es la misma transaccion devuelve
-- 'conflict' (nunca 'duplicate'), para que el consumidor alerte.
--
-- Resultado: jsonb {result: applied|duplicate|conflict|not_applicable, reason?, ...}.
--
-- sales_order_payments.payment_link_id pasa a referenciar el id del link DEL SERVICIO
-- (payments.payment_links), que no vive en public: se elimina su FK a
-- sales_order_payment_links (decision D5; el indice unico parcial se conserva).
-- Los pagos historicos conservan su valor; la rama legacy sigue insertando ids validos.

do $$
declare
  v_con text;
begin
  for v_con in
    select c.conname
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
     where c.conrelid = 'public.sales_order_payments'::regclass
       and c.contype = 'f'
       and a.attname = 'payment_link_id'
  loop
    execute format('alter table public.sales_order_payments drop constraint %I', v_con);
  end loop;
end $$;

create or replace function public.apply_wompi_order_payment(
  p_order_id uuid,
  p_tenant_id uuid,
  p_payment_link_id uuid,
  p_transaction_id text,
  p_amount_cents bigint,
  p_link_amount_cents bigint,
  p_currency text,
  p_reference text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order record;
  v_existing record;
  v_paid numeric;
  v_id uuid;
  v_constraint text;
begin
  if p_order_id is null or p_tenant_id is null or p_payment_link_id is null
     or p_transaction_id is null or p_transaction_id = ''
     or p_amount_cents is null or p_amount_cents <= 0 or p_link_amount_cents is null then
    return jsonb_build_object('result', 'not_applicable', 'reason', 'invalid_input');
  end if;

  -- Bloquea el pedido: serializa dos entregas concurrentes sobre el mismo pedido.
  select id, tenant_id, status, total, currency, deleted_at into v_order
    from public.sales_orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('result', 'not_applicable', 'reason', 'order_not_found');
  end if;
  -- Aislamiento: el pedido debe pertenecer al tenant que declara el sobre.
  if v_order.tenant_id is distinct from p_tenant_id then
    return jsonb_build_object('result', 'not_applicable', 'reason', 'tenant_mismatch');
  end if;

  -- Idempotencia por link (antes del estado del pedido: una reentrega tras el pago sigue siendo 'duplicate').
  select id, provider_transaction_id, deleted_at into v_existing
    from public.sales_order_payments where payment_link_id = p_payment_link_id;
  if found then
    if v_existing.deleted_at is not null then
      return jsonb_build_object('result', 'conflict', 'reason', 'previous_payment_deleted', 'payment_id', v_existing.id);
    elsif v_existing.provider_transaction_id is not distinct from p_transaction_id then
      return jsonb_build_object('result', 'duplicate', 'payment_id', v_existing.id, 'order_id', p_order_id);
    end if;
    return jsonb_build_object('result', 'conflict', 'reason', 'link_already_credited_with_other_transaction', 'payment_id', v_existing.id);
  end if;

  if v_order.deleted_at is not null or v_order.status not in ('confirmada', 'en_proceso', 'entregada') then
    return jsonb_build_object('result', 'not_applicable', 'reason', 'order_closed', 'order_status', v_order.status);
  end if;

  -- Monto de la transaccion = monto del link (lo que se pidio cobrar) y moneda del pedido.
  if p_amount_cents is distinct from p_link_amount_cents
     or p_currency is distinct from coalesce(v_order.currency, 'COP') then
    return jsonb_build_object('result', 'not_applicable', 'reason', 'amount_mismatch');
  end if;

  -- Una transaccion no acredita dos destinos.
  if exists (select 1 from public.sales_order_payments
              where provider_key = 'wompi' and provider_transaction_id = p_transaction_id and deleted_at is null)
     or exists (select 1 from public.payment_invoices where provider_transaction_id = p_transaction_id) then
    return jsonb_build_object('result', 'conflict', 'reason', 'transaction_already_applied');
  end if;

  -- Pedido ya pagado por completo: segundo cobro real (otro link), no se acredita: candidato a reembolso.
  select coalesce(sum(amount), 0) into v_paid
    from public.sales_order_payments where order_id = p_order_id and deleted_at is null;
  if v_paid >= v_order.total then
    return jsonb_build_object('result', 'conflict', 'reason', 'order_already_paid');
  end if;

  begin
    insert into public.sales_order_payments
      (tenant_id, order_id, method, amount, currency, provider_key, provider_transaction_id, provider_reference, payment_link_id)
    values
      (v_order.tenant_id, p_order_id, 'wompi', p_amount_cents::numeric / 100, p_currency, 'wompi', p_transaction_id, p_reference, p_payment_link_id)
    returning id into v_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'sales_order_payments_payment_link_idx' then
      -- Una entrega concurrente ganó la carrera: mismo trato que la rama de idempotencia.
      select id, provider_transaction_id into v_existing
        from public.sales_order_payments where payment_link_id = p_payment_link_id;
      if found and v_existing.provider_transaction_id is not distinct from p_transaction_id then
        return jsonb_build_object('result', 'duplicate', 'payment_id', v_existing.id, 'order_id', p_order_id);
      end if;
      return jsonb_build_object('result', 'conflict', 'reason', 'link_already_credited_with_other_transaction');
    end if;
    return jsonb_build_object('result', 'conflict', 'reason', 'transaction_already_applied');
  end;

  return jsonb_build_object('result', 'applied', 'payment_id', v_id, 'order_id', p_order_id,
                            'amount', p_amount_cents::numeric / 100);
end;
$$;

create or replace function public.apply_wompi_invoice_payment(
  p_invoice_id uuid,
  p_tenant_id uuid,
  p_transaction_id text,
  p_amount_cents bigint,
  p_link_amount_cents bigint,
  p_currency text,
  -- {method, brand, last_four, bank, reference, raw}: detalle de la transaccion (opcional).
  p_payment jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv record;
  v_claimed uuid;
begin
  if p_invoice_id is null or p_tenant_id is null or p_transaction_id is null or p_transaction_id = ''
     or p_amount_cents is null or p_amount_cents <= 0 or p_link_amount_cents is null then
    return jsonb_build_object('result', 'not_applicable', 'reason', 'invalid_input');
  end if;
  p_payment := coalesce(p_payment, '{}'::jsonb);

  select id, payer_tenant_id, status, amount_cents, currency, provider_transaction_id, deleted_at into v_inv
    from public.payment_invoices where id = p_invoice_id for update;
  if not found then
    return jsonb_build_object('result', 'not_applicable', 'reason', 'invoice_not_found');
  end if;
  -- Aislamiento: la factura debe ser del tenant pagador que declara el sobre.
  if v_inv.payer_tenant_id is distinct from p_tenant_id then
    return jsonb_build_object('result', 'not_applicable', 'reason', 'tenant_mismatch');
  end if;

  if v_inv.status = 'PAID' then
    if v_inv.provider_transaction_id is not distinct from p_transaction_id then
      return jsonb_build_object('result', 'duplicate', 'invoice_id', p_invoice_id);
    end if;
    -- Pagada por otra via (manual u otra transaccion): este cobro es candidato a reembolso.
    return jsonb_build_object('result', 'conflict', 'reason', 'invoice_already_paid');
  end if;
  if v_inv.deleted_at is not null or v_inv.status not in ('PENDING', 'OVERDUE') then
    return jsonb_build_object('result', 'not_applicable', 'reason', 'invoice_closed', 'invoice_status', v_inv.status);
  end if;

  if p_amount_cents is distinct from p_link_amount_cents
     or p_amount_cents is distinct from v_inv.amount_cents::bigint
     or p_currency is distinct from v_inv.currency then
    return jsonb_build_object('result', 'not_applicable', 'reason', 'amount_mismatch');
  end if;

  if exists (select 1 from public.payment_invoices where provider_transaction_id = p_transaction_id and id <> p_invoice_id)
     or exists (select 1 from public.sales_order_payments
                 where provider_key = 'wompi' and provider_transaction_id = p_transaction_id and deleted_at is null) then
    return jsonb_build_object('result', 'conflict', 'reason', 'transaction_already_applied');
  end if;

  begin
    -- Reclamo atomico PENDING/OVERDUE -> PAID; el trigger activate_subscription_on_invoice_paid
    -- activa/extiende la suscripcion igual que hoy.
    update public.payment_invoices
       set status = 'PAID',
           provider_transaction_id = p_transaction_id,
           provider_payment_method = p_payment->>'method',
           provider_payment_data = p_payment->'raw'
     where id = p_invoice_id and status in ('PENDING', 'OVERDUE')
    returning id into v_claimed;
  exception when unique_violation then
    return jsonb_build_object('result', 'conflict', 'reason', 'transaction_already_applied');
  end;
  if v_claimed is null then
    return jsonb_build_object('result', 'not_applicable', 'reason', 'invoice_closed');
  end if;

  insert into public.payment_attempts
    (invoice_id, provider_key, provider_transaction_id, status, amount_cents, currency,
     payment_method, payment_brand, payment_last_four, payment_bank, payment_reference, raw_data)
  values
    (p_invoice_id, 'wompi', p_transaction_id, 'APPROVED', p_amount_cents::integer, p_currency,
     p_payment->>'method', p_payment->>'brand', p_payment->>'last_four', p_payment->>'bank',
     p_payment->>'reference', p_payment->'raw');

  return jsonb_build_object('result', 'applied', 'invoice_id', p_invoice_id);
end;
$$;

revoke all on function public.apply_wompi_order_payment(uuid, uuid, uuid, text, bigint, bigint, text, text) from public, anon, authenticated;
revoke all on function public.apply_wompi_invoice_payment(uuid, uuid, text, bigint, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.apply_wompi_order_payment(uuid, uuid, uuid, text, bigint, bigint, text, text) to service_role;
grant execute on function public.apply_wompi_invoice_payment(uuid, uuid, text, bigint, bigint, text, jsonb) to service_role;

-- Guarda del consumidor: el cliente cuyo secreto firma los avisos DEBE ser interno,
-- activo y no revocado. Un cliente externo conoce su propio secreto y podria forjar
-- un sobre con metadata mentirosa. Solo service_role.
create or replace function public.payments_internal_client_ok(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from payments.clients
     where id = p_client_id and kind = 'internal' and status = 'active' and revoked_at is null
       and signing_secret_name is not null
  );
$$;
revoke all on function public.payments_internal_client_ok(uuid) from public, anon, authenticated;
grant execute on function public.payments_internal_client_ok(uuid) to service_role;
