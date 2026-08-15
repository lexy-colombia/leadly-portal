-- Closes the only gap in the payments module: until now the sole path to
-- PAID was the Wompi webhook (or sync-payment-invoices reconciling against
-- Wompi). A tenant that pays by bank transfer or cash has no way to be
-- reflected as paid. This mirrors applyWebhookEvent.ts's insert-attempt +
-- flip-to-PAID logic (same idempotency guard: only acts on PENDING/OVERDUE)
-- so activate_subscription_on_invoice_paid fires exactly the same way a
-- Wompi payment would. Superadmin-only, checked inside the function (same
-- pattern as set_platform_ai_key) rather than via a table RLS policy, since
-- payment_attempts intentionally has no authenticated insert policy at all.
create or replace function public.record_manual_payment(
  p_invoice_id uuid,
  p_amount_cents integer,
  p_payment_method text,
  p_payment_reference text,
  p_note text
) returns public.payment_invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.payment_invoices;
begin
  if not public.is_superadmin() then
    raise exception 'Solo el superadmin puede registrar pagos manuales';
  end if;

  select * into v_invoice from public.payment_invoices where id = p_invoice_id and deleted_at is null;
  if not found then
    raise exception 'Factura no encontrada';
  end if;
  if v_invoice.status not in ('PENDING', 'OVERDUE') then
    raise exception 'Esta factura ya no está pendiente de pago';
  end if;

  insert into public.payment_attempts (
    invoice_id, provider_key, provider_transaction_id, status,
    amount_cents, currency, payment_method, payment_reference, raw_data
  ) values (
    p_invoice_id, 'manual', null, 'APPROVED',
    coalesce(p_amount_cents, v_invoice.amount_cents), v_invoice.currency, p_payment_method, p_payment_reference,
    jsonb_build_object('note', p_note, 'recorded_by', auth.uid())
  );

  update public.payment_invoices
  set status = 'PAID', provider_payment_method = p_payment_method
  where id = p_invoice_id
  returning * into v_invoice;

  return v_invoice;
end;
$$;

revoke execute on function public.record_manual_payment(uuid, integer, text, text, text) from public, anon;
grant execute on function public.record_manual_payment(uuid, integer, text, text, text) to authenticated;
