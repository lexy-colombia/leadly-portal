-- Corrige un diseño equivocado introducido el mismo día en
-- sendCreditNoteToDian.ts: marcar la factura original como 'voided' al
-- emitir una nota crédito de motivo "2 - Anulación de factura electrónica".
-- Dos migraciones anteriores ya habían dejado asentado que ese flujo NO
-- existe en este esquema -- 20260903110000_sales_invoices.sql ("invalidar
-- una ya enviada es el flujo de nota-crédito de una fase futura") y
-- 20260908120000_sales_orders_has_invoice.sql ("no existe ningún flujo de
-- anular una factura ya aceptada... un rechazo se corrige con un intento
-- NUEVO, nunca editando el que ya se aceptó"). Pedido explícito del usuario
-- 2026-09-09, el mismo día que se probó la primera nota crédito real: una
-- factura DIAN nunca se anula -- la nota crédito ES el mecanismo legal de
-- corrección, la factura original se queda tal cual (sent/accepted) para
-- siempre como parte del historial de documentos emitidos del pedido.
--
-- Lo que sí hacía falta de verdad (y el 'voided' era un intento torpe de
-- resolver) es poder volver a facturar el mismo pedido una vez que la
-- factura vigente ya quedó acreditada del todo por nota crédito -- eso es
-- lo que agrega el trigger de abajo, reemplazando al índice único parcial
-- que solo podía mirar el status de sales_invoices, nunca el saldo
-- acreditado (eso vive en sales_credit_notes, una tabla distinta).

-- 1. Dato real de prueba a corregir: la única factura que llegó a
--    marcarse 'voided' (orden 907f4c82-2554-43d2-9804-af710fa04c76,
--    intento 4) vuelve a 'sent', su estado real antes del bug -- nunca se
--    reescribió el intento en sí, solo el status quedó mal.
update public.sales_invoices set status = 'sent' where status = 'voided';

-- 2. 'voided' deja de ser un valor válido para sales_invoices.status --
--    nada en el código lo vuelve a escribir desde ahora.
alter table public.sales_invoices drop constraint sales_invoices_status_check;
alter table public.sales_invoices add constraint sales_invoices_status_check
  check (status in ('pending', 'blocked_missing_buyer_data', 'generating', 'generated', 'sending', 'sent', 'accepted', 'rejected', 'error'));

-- 3. Reemplaza sales_invoices_order_id_live_idx. La regla real ya no es
--    "como mucho un intento no rechazado por pedido" -- ahora un pedido
--    puede tener MÁS de una factura sent/accepted a la vez en su
--    historial (la vigente + las que ya quedaron superadas por una nota
--    crédito total), así que un índice único parcial por status no alcanza
--    para expresarla. El trigger reimplementa la misma protección
--    (como mucho un intento "vivo" -- no rechazado/error -- a la vez) y
--    además la regla nueva: si el intento vivo actual ya está
--    sent/accepted, solo se puede crear uno nuevo si quedó totalmente
--    acreditado por nota crédito.
drop index public.sales_invoices_order_id_live_idx;

create or replace function public.guard_sales_invoice_live_attempt()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing record;
  v_credited numeric;
begin
  -- Un intento que nace rechazado/con error (no debería pasar en la
  -- práctica, pero no hay motivo para bloquearlo) nunca compite por "el
  -- intento vivo" del pedido.
  if new.status in ('rejected', 'error') then
    return new;
  end if;

  -- Bloquea la fila del PEDIDO (siempre existe, a diferencia de
  -- sales_invoices para el primer intento) para serializar dos intentos de
  -- factura concurrentes sobre el mismo pedido -- sin este lock, dos
  -- inserts que arrancan a la vez (ej. doble click en "Reintentar"/"Emitir
  -- nueva factura") verían ambos "sin intento vivo todavía" y las dos
  -- pasarían, dejando dos intentos vivos a la vez. Mismo criterio de "for
  -- update" que ya usa create_credit_note_attempt, solo que acá no hay
  -- necesariamente una fila de sales_invoices previa que bloquear.
  perform 1 from public.sales_orders where id = new.order_id for update;

  select id, status, total into v_existing
  from public.sales_invoices
  where order_id = new.order_id and status not in ('rejected', 'error')
  order by attempt_number desc
  limit 1;

  if v_existing.id is null then
    return new;
  end if;

  if v_existing.status not in ('sent', 'accepted') then
    raise exception 'Este pedido ya tiene una factura en curso (estado "%"); esperá a que se resuelva antes de generar otro intento.', v_existing.status;
  end if;

  select coalesce(sum(total), 0) into v_credited
  from public.sales_credit_notes
  where invoice_id = v_existing.id and status in ('sent', 'accepted');

  -- Misma tolerancia de 1 centavo que create_credit_note_attempt.
  if v_credited + 0.01 < v_existing.total then
    raise exception 'La factura vigente de este pedido todavía no está acreditada por completo -- emití una nota crédito por el saldo restante antes de generar una factura nueva.';
  end if;

  return new;
end;
$$;

create trigger sales_invoices_guard_live_attempt before insert on public.sales_invoices
  for each row execute function public.guard_sales_invoice_live_attempt();

-- Mismo motivo que 20260903180100_sales_order_confirm_triggers_revoke_public_execute.sql:
-- todo SECURITY DEFINER en public se auto-expone como RPC vía PostgREST.
-- A diferencia de esa migración (donde revocar de PUBLIC alcanzaba), acá
-- get_advisors siguió marcando la función como ejecutable por anon/
-- authenticated después de revocar solo de PUBLIC -- este proyecto ya
-- tiene privilegios por default que le dan EXECUTE directo a esos dos
-- roles en toda función nueva de public, así que hace falta revocárselo
-- explícitamente a cada uno, no solo al pseudo-grupo.
revoke execute on function public.guard_sales_invoice_live_attempt() from public, anon, authenticated;
