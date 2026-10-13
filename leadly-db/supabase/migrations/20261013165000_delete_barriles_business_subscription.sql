-- Correccion de DATOS: borra la suscripcion Business de "Barriles de la sexta"
-- (y su unica factura PENDING) para que la migracion 20261013170000 pueda
-- cargar la Enterprise pactada. Contrato: progress/brief_correccion_suscripciones.md.
-- NO cambia esquema ni funciones. Debe aplicarse ANTES que 20261013170000
-- (la guarda de esa migracion aborta si Barriles ya tiene una suscripcion).
--
-- Contexto: el usuario creo la suscripcion Business a mano desde el backoffice
-- (2026-10-13) y pidio reemplazarla por la Enterprise a $140.000 sin
-- implementacion. La factura (INV-20261013-dc88ce, 49.000.000 centavos =
-- 14.000.000 base + 35.000.000 implementacion) nunca se pago ni tuvo intentos.
--
-- Orden: primero la factura (payment_invoices.subscription_id es ON DELETE
-- SET NULL; borrar la suscripcion antes dejaria la factura huerfana; sus items
-- y payment_attempts caen en cascada), despues la suscripcion
-- (billing_subscription_modules cae en cascada, pero la guarda exige 0 filas).
-- billing_subscriptions no tiene trigger de DELETE: no se toca
-- tenant_enabled_modules (si la Business habia agregado filas source='plan', la
-- sincronizacion de 20261013170000 las re-etiqueta o las deja como estan).
--
-- Aborta SIN escribir (una sola transaccion) si el estado difiere de lo
-- verificado. Idempotente: si la suscripcion ya no existe, avisa y sale.
do $$
declare
  c_tenant constant uuid := '9c79437d-1c19-4edc-bc1f-0dc06094823a';
  c_name constant text := 'Barriles de la sexta';
  c_sub constant uuid := '40e2450d-c79c-4c22-bbf2-cff6f57361c3';
  v_sub public.billing_subscriptions;
  v_plan_key text;
  v_n integer;
  v_bad integer;
  v_deleted_inv integer;
begin
  select * into v_sub from public.billing_subscriptions where id = c_sub;
  if not found then
    raise notice 'delete_barriles_business_subscription: la suscripcion % ya no existe; nada que hacer', c_sub;
    return;
  end if;

  if v_sub.tenant_id <> c_tenant then
    raise exception 'delete_barriles_business_subscription: la suscripcion % pertenece al tenant %, no a Barriles; no se escribe nada', c_sub, v_sub.tenant_id;
  end if;
  perform 1 from public.tenants where id = c_tenant and name = c_name;
  if not found then
    raise exception 'delete_barriles_business_subscription: el tenant % no existe o no se llama "%"; no se escribe nada', c_tenant, c_name;
  end if;

  if v_sub.status <> 'PENDING_PAYMENT' then
    raise exception 'delete_barriles_business_subscription: la suscripcion esta en estado %, se esperaba PENDING_PAYMENT; no se escribe nada', v_sub.status;
  end if;

  select key into v_plan_key from public.billing_plans where id = v_sub.plan_id;
  if v_plan_key is distinct from 'business' then
    raise exception 'delete_barriles_business_subscription: el plan de la suscripcion es %, se esperaba business; no se escribe nada', v_plan_key;
  end if;

  select count(*) into v_n from public.billing_subscription_modules where subscription_id = c_sub;
  if v_n <> 0 then
    raise exception 'delete_barriles_business_subscription: la suscripcion tiene % modulo(s) negociado(s); no se escribe nada', v_n;
  end if;

  -- Toda factura (incluso borrada logicamente) debe ser PENDING y sin intentos de pago.
  select count(*) into v_bad
  from public.payment_invoices i
  where i.subscription_id = c_sub
    and (i.status <> 'PENDING'
         or i.payer_tenant_id is distinct from c_tenant
         or exists (select 1 from public.payment_attempts a where a.invoice_id = i.id));
  if v_bad <> 0 then
    raise exception 'delete_barriles_business_subscription: % factura(s) de la suscripcion no estan PENDING, tienen intentos de pago o son de otro tenant; no se escribe nada', v_bad;
  end if;

  -- 20261013170000 exige que Barriles no tenga otras suscripciones ni facturas.
  select count(*) into v_n from public.billing_subscriptions where tenant_id = c_tenant and id <> c_sub;
  if v_n <> 0 then
    raise exception 'delete_barriles_business_subscription: Barriles tiene % suscripcion(es) adicional(es); no se escribe nada', v_n;
  end if;
  select count(*) into v_n from public.payment_invoices
   where payer_tenant_id = c_tenant and subscription_id is distinct from c_sub;
  if v_n <> 0 then
    raise exception 'delete_barriles_business_subscription: Barriles tiene % factura(s) ajena(s) a esta suscripcion; no se escribe nada', v_n;
  end if;

  -- Primero la factura (items y payment_attempts en cascada), luego la suscripcion.
  delete from public.payment_invoices where subscription_id = c_sub;
  get diagnostics v_deleted_inv = row_count;
  delete from public.billing_subscriptions where id = c_sub;

  select count(*) into v_n from public.billing_subscriptions where tenant_id = c_tenant;
  if v_n <> 0 then
    raise exception 'delete_barriles_business_subscription: tras borrar Barriles aun tiene % suscripcion(es)', v_n;
  end if;
  select count(*) into v_n from public.payment_invoices where payer_tenant_id = c_tenant;
  if v_n <> 0 then
    raise exception 'delete_barriles_business_subscription: tras borrar Barriles aun tiene % factura(s)', v_n;
  end if;

  raise notice 'delete_barriles_business_subscription: aplicada (suscripcion % y % factura(s) borradas)', c_sub, v_deleted_inv;
end
$$;
