-- Revierte el pago de PRUEBA (sandbox, tarjeta 4242, 2026-10-20) hecho sobre la factura de
-- plataforma INV-20261013-c3a306 de Barriles de la sexta (140.000 COP). Pedido explicito del
-- usuario (2026-10-20): "elimina primero ese pago, funciono correctamente". La factura
-- vuelve a quedar PENDIENTE como estaba antes de la prueba y desaparece todo el rastro de
-- sandbox del servicio de pagos (link, historial, evento, aviso y su intento).
--
-- Que se restaura en public.payment_invoices: status PENDING, provider_transaction_id /
-- provider_payment_method / provider_payment_data en null y payments_link_id en null. Este
-- ultimo es IMPORTANTE: si quedara apuntando al link de sandbox ya pagado, create-payment-
-- checkout respondera 409 al cobrar de verdad, o reutilizara un checkout de sandbox.
-- Se borra la fila de public.payment_attempts de la prueba. La suscripcion NO se toca (el
-- trigger activate_subscription_on_invoice_paid no movio nada porque estaba ACTIVE; aqui se
-- VERIFICA que siga igual y se aborta si no).
--
-- payments.events / link_status_history / deliveries / delivery_attempts son solo-insertar:
-- se deshabilitan SOLO sus triggers de proteccion y SOLO dentro de esta transaccion; se
-- vuelven a habilitar antes de salir y cualquier fallo revierte todo (DDL transaccional).
--
-- Acotada por ids exactos verificados contra la base real. Aborta si algo no coincide. Si la
-- factura no existe (otro ambiente) o ya esta PENDING, no hace nada.
do $$
declare
  c_invoice constant uuid := '5851bd75-6fd7-4ae8-bae6-f2ec705e9010';
  c_link constant uuid := '643bcb69-5d0e-4272-9f39-2a30b3565bf6';
  c_tx constant text := '12055712-1792527040-34421';
  c_attempt constant uuid := '7ad20c61-809f-47ae-acf8-d6493a1231b4';
  c_client constant uuid := 'd01aaca8-4594-4f87-b5a2-4de093fc547e';
  c_payer constant uuid := '9c79437d-1c19-4edc-bc1f-0dc06094823a';
  v_inv record;
  v_sub record;
  v_link record;
  n_hist int; n_events int; n_deliv int; n_dattempts int; n_pattempts int; n_links int;
begin
  select id, status, provider_transaction_id, payments_link_id, payer_tenant_id, subscription_id
    into v_inv from public.payment_invoices where id = c_invoice;
  if not found then
    raise notice 'revert_barriles_test_payment: la factura no existe; no se hace nada.';
    return;
  end if;
  if v_inv.status = 'PENDING' and v_inv.provider_transaction_id is null and v_inv.payments_link_id is null then
    raise notice 'revert_barriles_test_payment: la factura ya esta pendiente y sin rastro; no se hace nada.';
    return;
  end if;

  -- la factura debe estar EXACTAMENTE como la dejo la prueba
  if v_inv.status <> 'PAID' or v_inv.provider_transaction_id is distinct from c_tx
     or v_inv.payments_link_id is distinct from c_link or v_inv.payer_tenant_id <> c_payer then
    raise exception 'revert_barriles_test_payment: la factura no esta en el estado esperado de la prueba (status=%, tx=%, link=%); se aborta.',
      v_inv.status, v_inv.provider_transaction_id, v_inv.payments_link_id;
  end if;

  -- la suscripcion no debe haberse movido (sigue ACTIVE y sin cambios posteriores a la prueba)
  select status, updated_at into v_sub from public.billing_subscriptions where id = v_inv.subscription_id;
  if not found or v_sub.status <> 'ACTIVE' or v_sub.updated_at >= timestamptz '2026-10-20 00:00:00+00' then
    raise exception 'revert_barriles_test_payment: la suscripcion cambio despues de la prueba (status=%, updated_at=%); se aborta para no dejar un estado a medias.',
      v_sub.status, v_sub.updated_at;
  end if;

  -- rastro del servicio: exactamente lo verificado
  select * into v_link from payments.payment_links where id = c_link;
  if not found or v_link.environment <> 'sandbox' or v_link.status <> 'paid' or v_link.client_id <> c_client
     or v_link.paid_transaction_id is distinct from c_tx or v_link.external_reference <> 'invoice:' || c_invoice::text then
    raise exception 'revert_barriles_test_payment: el link del servicio no es el esperado; se aborta.';
  end if;
  select count(*) into n_links from payments.payment_links;
  select count(*) into n_hist from payments.link_status_history where link_id = c_link;
  select count(*) into n_events from payments.events where link_id = c_link;
  select count(*) into n_deliv from payments.deliveries where link_id = c_link;
  select count(*) into n_dattempts from payments.delivery_attempts a join payments.deliveries d on d.id = a.delivery_id where d.link_id = c_link;
  select count(*) into n_pattempts from public.payment_attempts where invoice_id = c_invoice;
  if n_links <> 1 or n_hist <> 3 or n_events <> 1 or n_deliv <> 1 or n_dattempts <> 1 or n_pattempts <> 1
     or not exists (select 1 from public.payment_attempts where id = c_attempt and invoice_id = c_invoice and provider_transaction_id = c_tx) then
    raise exception 'revert_barriles_test_payment: conteos inesperados (links=%, historial=%, eventos=%, entregas=%, intentos de entrega=%, payment_attempts=%); se aborta.',
      n_links, n_hist, n_events, n_deliv, n_dattempts, n_pattempts;
  end if;

  -- 1) la factura vuelve a como estaba antes de la prueba
  delete from public.payment_attempts where id = c_attempt;
  update public.payment_invoices
     set status = 'PENDING',
         provider_transaction_id = null,
         provider_payment_method = null,
         provider_payment_data = null,
         payments_link_id = null
   where id = c_invoice;

  -- 2) rastro de sandbox del servicio (orden obligatorio por las FK: intentos -> entregas -> historial -> eventos -> link)
  alter table payments.delivery_attempts disable trigger delivery_attempts_append_only;
  alter table payments.deliveries disable trigger deliveries_guard;
  alter table payments.link_status_history disable trigger link_status_history_append_only;
  alter table payments.events disable trigger events_append_only;

  delete from payments.delivery_attempts where delivery_id in (select id from payments.deliveries where link_id = c_link);
  delete from payments.deliveries where link_id = c_link;
  delete from payments.link_status_history where link_id = c_link;
  delete from payments.events where link_id = c_link;
  delete from payments.payment_links where id = c_link;

  alter table payments.delivery_attempts enable trigger delivery_attempts_append_only;
  alter table payments.deliveries enable trigger deliveries_guard;
  alter table payments.link_status_history enable trigger link_status_history_append_only;
  alter table payments.events enable trigger events_append_only;

  raise notice 'revert_barriles_test_payment: factura restaurada a PENDING y rastro de sandbox eliminado.';
end
$$;
