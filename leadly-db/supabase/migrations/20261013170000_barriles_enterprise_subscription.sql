-- Carga de DATOS: suscripcion Enterprise de "Barriles de la sexta" (cliente real).
-- Contrato: progress/brief_suscripcion_barriles.md. NO cambia esquema ni funciones.
--
-- Decision del usuario (2026-10-12): "barriles plan enterprise pero en 140.000,
-- habilitale todo, y ellos ya me pagaron 1 factura de 10 de septiembre a 10 de
-- octubre, agregala tambien"; "costos de implementacion en 0"; "vence el 10 de
-- cada mes".
--
-- ORDEN DE OPERACIONES (decidido leyendo las funciones y triggers reales):
--  a) El INSERT de la suscripcion dispara billing_subscriptions_create_initial_invoice,
--     que llama create_invoice_for_subscription: genera SOLA la factura del periodo
--     vigente con due_date = current_period_end::date. Por eso la suscripcion nace
--     ACTIVE con el periodo historico 2026-09-10 -> 2026-10-10: esa factura es la
--     historica (due 2026-10-10). Nacer PENDING_PAYMENT NO sirve: la funcion
--     "reinicia" el periodo a now() si current_period_end ya paso y no hay facturas.
--  b) setup_fee_billed_at no nulo desde el INSERT + setup_fee_override_cents = 0:
--     jamas se factura implementacion, aunque el plan la tuviera.
--  c) La factura historica se paga con las mismas dos escrituras de
--     record_manual_payment (payment_attempts manual APPROVED + status PAID). No se
--     puede llamar a la funcion: exige is_superadmin() y una migracion corre sin
--     sesion (auth.uid() nulo). El UPDATE a PAID dispara
--     activate_subscription_on_invoice_paid, que AVANZA el periodo (+1 mes, desde
--     current_period_end): queda 2026-10-10 -> 2026-11-10 y status ACTIVE.
--  d) Modulos: TODO el catalogo (entitlement_module_keys()) a $0 en
--     billing_subscription_modules. Su trigger de sync agrega filas
--     source='subscription' para los que no estaban; las 'manual' no se tocan.
--  e) Recien entonces create_invoice_for_subscription genera la factura PENDIENTE del
--     periodo vigente (due 2026-11-10): base 140.000 + 24 lineas de modulo a $0
--     ("Modulo: X - Incluido sin costo ..."), sin linea de implementacion.
--
-- SUPUESTO del Lider (no verificado con el cliente): la factura pagada fue de
-- 140.000 (14000000 centavos), pagada por transferencia el 2026-09-10.
--
-- Montos en centavos, IVA incluido (la factura separa base e IVA 19%).
-- Aborta (sin escribir nada: es una sola transaccion) si el estado difiere de lo
-- verificado; idempotente: si ya esta aplicada, no hace nada.
do $$
declare
  c_tenant constant uuid := '9c79437d-1c19-4edc-bc1f-0dc06094823a';
  c_name constant text := 'Barriles de la sexta';
  c_base constant integer := 14000000;
  c_setup_override constant integer := 0; -- M1
  c_setup_billed constant timestamptz := '2026-09-10 00:00:00-05'; -- M1
  c_start constant timestamptz := '2026-09-10 00:00:00-05';
  c_end constant timestamptz := '2026-10-10 00:00:00-05';
  c_next_end constant timestamptz := '2026-11-10 00:00:00-05';
  c_note constant text := 'Incluido sin costo (acuerdo con el cliente)';
  v_plan record;
  v_sub uuid;
  v_inv_a uuid;
  v_inv_b uuid;
  v_n integer;
  v_keys text[] := public.entitlement_module_keys();
  v_row record;
begin
  perform 1 from public.tenants where id = c_tenant and name = c_name;
  if not found then
    raise exception 'barriles_enterprise_subscription: el tenant % no existe o no se llama "%"; no se escribe nada', c_tenant, c_name;
  end if;

  select id, is_custom into v_plan from public.billing_plans where key = 'enterprise';
  if not found or v_plan.is_custom is not true then
    raise exception 'barriles_enterprise_subscription: el plan enterprise no existe o no es is_custom; no se escribe nada';
  end if;

  -- Ya aplicada: una unica suscripcion enterprise a 14000000 con la factura historica PAID.
  select count(*) into v_n from public.billing_subscriptions where tenant_id = c_tenant;
  if v_n > 0 then
    if v_n = 1
       and exists (
         select 1 from public.billing_subscriptions s
         where s.tenant_id = c_tenant and s.plan_id = v_plan.id and s.custom_base_amount_cents = c_base
           and s.status in ('ACTIVE', 'PENDING_PAYMENT')
           and exists (select 1 from public.payment_invoices i
                       where i.subscription_id = s.id and i.status = 'PAID'
                         and i.due_date = date '2026-10-10' and i.deleted_at is null)
       ) then
      raise notice 'barriles_enterprise_subscription: ya aplicada; nada que hacer';
      return;
    end if;
    raise exception 'barriles_enterprise_subscription: el tenant ya tiene % suscripcion(es) con datos distintos de los esperados; no se escribe nada', v_n;
  end if;

  select count(*) into v_n from public.payment_invoices where payer_tenant_id = c_tenant;
  if v_n > 0 then
    raise exception 'barriles_enterprise_subscription: el tenant ya tiene % factura(s) de plataforma sin suscripcion; no se escribe nada', v_n;
  end if;

  -- a/b) Suscripcion: nace ACTIVE con el periodo historico; el trigger crea la factura (due 2026-10-10).
  insert into public.billing_subscriptions (
    tenant_id, plan_id, status, current_period_start, current_period_end,
    custom_base_amount_cents, setup_fee_override_cents, setup_fee_billed_at,
    cancel_at_period_end, created_at
  ) values (
    c_tenant, v_plan.id, 'ACTIVE', c_start, c_end,
    c_base, c_setup_override, c_setup_billed,
    false, c_start
  ) returning id into v_sub;

  select count(*) into v_n from public.payment_invoices where subscription_id = v_sub and deleted_at is null;
  if v_n <> 1 then
    raise exception 'barriles_enterprise_subscription: se esperaba 1 factura generada por el alta, hay %', v_n;
  end if;
  select id into v_inv_a from public.payment_invoices where subscription_id = v_sub and deleted_at is null;
  perform 1 from public.payment_invoices
   where id = v_inv_a and status = 'PENDING' and due_date = date '2026-10-10' and amount_cents = c_base;
  if not found then
    raise exception 'barriles_enterprise_subscription: la factura historica no salio PENDING / due 2026-10-10 / % centavos', c_base;
  end if;
  perform 1 from public.payment_invoice_items
   where invoice_id = v_inv_a and description like 'Implementaci%';
  if found then
    raise exception 'barriles_enterprise_subscription: la factura historica trae linea de implementacion';
  end if;

  -- c) Pago manual (mismas escrituras que record_manual_payment).
  if true then -- M2
    insert into public.payment_attempts (
      invoice_id, provider_key, provider_transaction_id, status,
      amount_cents, currency, payment_method, payment_reference, raw_data, created_at
    ) values (
      v_inv_a, 'manual', null, 'APPROVED',
      c_base, 'COP', 'transferencia', null,
      jsonb_build_object('note', 'Carga historica: pago de la suscripcion 2026-09-10 a 2026-10-10 (monto supuesto 140.000)',
                         'recorded_by', null),
      c_start
    );
    update public.payment_invoices
       set status = 'PAID', provider_payment_method = 'transferencia'
     where id = v_inv_a;
  end if;

  perform 1 from public.billing_subscriptions
   where id = v_sub and status = 'ACTIVE' and current_period_start = c_end and current_period_end = c_next_end;
  if not found then
    raise exception 'barriles_enterprise_subscription: tras el pago el periodo no quedo 2026-10-10 -> 2026-11-10 ACTIVE';
  end if;

  -- La factura historica se emitio al inicio de su periodo.
  update public.payment_invoices
     set created_at = c_start,
         invoice_number = regexp_replace(invoice_number, '^INV-[0-9]{8}-', 'INV-20260910-')
   where id = v_inv_a;

  -- d) Todos los modulos del catalogo, a $0.
  if true then -- M3
    insert into public.billing_subscription_modules (subscription_id, module_key, price_cents, note)
    select v_sub, k, 0, c_note from unnest(v_keys) k;
  end if;

  -- e) Factura del periodo vigente (due 2026-11-10).
  v_inv_b := public.create_invoice_for_subscription(v_sub);
  if v_inv_b is null then
    raise exception 'barriles_enterprise_subscription: no se genero la factura del periodo vigente';
  end if;
  perform 1 from public.payment_invoices
   where id = v_inv_b and status = 'PENDING' and due_date = date '2026-11-10' and amount_cents = c_base;
  if not found then
    raise exception 'barriles_enterprise_subscription: la factura vigente no salio PENDING / due 2026-11-10 / % centavos', c_base;
  end if;

  for v_row in
    select i.id, i.amount_cents, coalesce(sum(it.subtotal_cents), 0) as s,
           count(*) filter (where it.description like 'Implementaci%') as setup_lines
    from public.payment_invoices i
    left join public.payment_invoice_items it on it.invoice_id = i.id
    where i.subscription_id = v_sub
    group by i.id, i.amount_cents
  loop
    if v_row.s <> v_row.amount_cents or v_row.setup_lines > 0 then
      raise exception 'barriles_enterprise_subscription: la factura % no cuadra (items % vs monto %, lineas de implementacion %)',
        v_row.id, v_row.s, v_row.amount_cents, v_row.setup_lines;
    end if;
  end loop;

  select count(*) into v_n from public.billing_subscription_modules where subscription_id = v_sub and price_cents = 0;
  if v_n <> cardinality(v_keys) then
    raise exception 'barriles_enterprise_subscription: modulos a $0 = %, catalogo = %', v_n, cardinality(v_keys);
  end if;
  perform 1 from public.tenants where id = c_tenant and status = 'active';
  if not found then
    raise exception 'barriles_enterprise_subscription: el tenant no quedo active';
  end if;

  raise notice 'barriles_enterprise_subscription: aplicada (suscripcion %, facturas % PAID y % PENDING)', v_sub, v_inv_a, v_inv_b;
end
$$;
