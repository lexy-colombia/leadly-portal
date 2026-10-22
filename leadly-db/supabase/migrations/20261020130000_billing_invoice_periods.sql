-- Cobro anticipado de suscripciones, parte 1: periodo explicito en cada comprobante.
-- Plan: progress/feature_billing_prepaid.md (D1 + D2).
--
-- D1. payment_invoices gana period_start / period_end (el periodo que cubre el
--     comprobante). Hasta hoy el periodo solo se inferia por due_date = fin del
--     periodo; al mover el vencimiento al INICIO del periodo (cobro anticipado)
--     esa inferencia deja de servir, asi que el dedupe pasa a (subscription_id,
--     period_start) con un indice unico parcial (la base lo garantiza aunque dos
--     corridas se solapen).
--     Backfill GENERICO por regla (no por id): en todo comprobante de
--     suscripcion creado por create_invoice_for_subscription, due_date era el fin
--     del periodo, asi que period_end = due_date y period_start = due_date - 1
--     intervalo del plan. Da, para los comprobantes reales: Barriles PAID
--     [2026-09-10, 2026-10-10], PENDING [2026-10-10, 2026-11-10]; Faiver PAID
--     [2026-10-05, 2026-11-05]. Si dos comprobantes vivos de una misma suscripcion
--     colisionaran, el CREATE UNIQUE INDEX aborta la migracion entera (falla
--     cerrado, nada queda a medias: una migracion es una transaccion).
--
-- D2. create_invoice_for_subscription(p_subscription_id uuid, p_period_start date
--     default null). Una sola funcion; se hace DROP de la firma de 1 argumento
--     (los llamadores de 1 argumento --trigger AFTER INSERT de la suscripcion y
--     lib/api/billing.ts-- siguen funcionando por el default).
--       * p_period_start NULL  = periodo vigente de la suscripcion (alta,
--         negociacion; conserva el reinicio de periodo de PENDING_PAYMENT).
--       * p_period_start dado  = renovacion explicita [p_period_start, +1 intervalo].
--       * due_date: la PRIMERA factura de la suscripcion vence HOY; una renovacion
--         vence el dia que empieza su periodo (cobro anticipado), pero nunca antes
--         de hoy (una renovacion tardia no nace ya vencida: el cliente tendria el
--         tenant bloqueado a los 4 dias sin haber visto nunca el comprobante).
--       * dedupe por (subscription_id, period_start).
--     Se conserva TODA la logica previa (items, plan a la medida con modulos y
--     setup fee solo en la primera, atajo total 0, plan custom en 0 no factura,
--     tope integer, guarda de superadmin). Definicion de partida:
--     20261013130000_plans_entitlements.sql (seccion 11).
--
-- Idempotente: add column if not exists, backfill solo donde period_start es null,
-- indice if not exists, drop function if exists + create or replace.

alter table public.payment_invoices
  add column if not exists period_start date,
  add column if not exists period_end date;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payment_invoices_period_order_check'
                 and conrelid = 'public.payment_invoices'::regclass) then
    alter table public.payment_invoices
      add constraint payment_invoices_period_order_check
      check (period_start is null or period_end is null or period_end > period_start);
  end if;
end
$$;

update public.payment_invoices pi
set period_end = pi.due_date,
    period_start = (pi.due_date - case bp.billing_interval when 'yearly' then interval '1 year' else interval '1 month' end)::date
from public.billing_subscriptions bs
join public.billing_plans bp on bp.id = bs.plan_id
where pi.subscription_id = bs.id
  and pi.deleted_at is null
  and pi.due_date is not null
  and pi.period_start is null;

-- Verificacion del backfill contra los comprobantes reales conocidos (si existen).
do $$
declare
  v_bad integer;
begin
  select count(*) into v_bad
  from public.payment_invoices
  where id = '5851bd75-6fd7-4ae8-bae6-f2ec705e9010'
    and (period_start is distinct from date '2026-10-10' or period_end is distinct from date '2026-11-10');
  if v_bad > 0 then
    raise exception 'billing_invoice_periods: el comprobante pendiente de Barriles no quedo en [2026-10-10, 2026-11-10]; no se escribe nada';
  end if;
  select count(*) into v_bad
  from public.payment_invoices
  where subscription_id is not null and deleted_at is null and due_date is not null and period_start is null;
  if v_bad > 0 then
    raise exception 'billing_invoice_periods: % comprobante(s) de suscripcion quedaron sin periodo tras el backfill', v_bad;
  end if;
end
$$;

create unique index if not exists payment_invoices_subscription_period_uidx
  on public.payment_invoices (subscription_id, period_start)
  where deleted_at is null and subscription_id is not null;

drop function if exists public.create_invoice_for_subscription(uuid);

create or replace function public.create_invoice_for_subscription(p_subscription_id uuid, p_period_start date default null) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.billing_subscriptions;
  v_plan public.billing_plans;
  v_invoice_id uuid;
  v_base bigint := 0;
  v_modules_total bigint := 0;
  v_setup bigint := 0;
  v_total bigint;
  v_zero_shortcut boolean;
  v_order integer := 0;
  v_mod record;
  v_interval interval;
  v_pstart date;
  v_pend date;
  v_first boolean;
  v_due date;
  v_labels constant jsonb := jsonb_build_object(
    'dashboard', 'Panel', 'products', 'Productos', 'inventory', 'Inventario', 'sales', 'Ventas',
    'pos', 'Punto de venta', 'contacts', 'Clientes', 'credit', 'Crédito', 'expenses', 'Gastos',
    'returns', 'Devoluciones', 'reports', 'Reportes', 'settings', 'Configuración',
    'billing', 'Facturación', 'dispatches', 'Despachos', 'einvoicing', 'Facturación electrónica',
    'storefront', 'Tienda en línea', 'integrations', 'Integraciones', 'conversations', 'Conversaciones',
    'channels', 'Canales', 'aiAgents', 'Agentes de IA', 'pipeline', 'Oportunidades', 'tasks', 'Tareas',
    'calendar', 'Calendario', 'campaigns', 'Campañas', 'automations', 'Automatizaciones'
  );
begin
  if auth.uid() is not null and not public.is_superadmin() then
    raise exception 'Solo el superadmin puede generar la factura de una suscripción';
  end if;

  select * into v_sub from public.billing_subscriptions where id = p_subscription_id;
  if not found then
    raise exception 'billing_subscription % no existe', p_subscription_id;
  end if;

  select * into v_plan from public.billing_plans where id = v_sub.plan_id;
  if not found then
    return null;
  end if;

  v_interval := case v_plan.billing_interval when 'yearly' then interval '1 year' else interval '1 month' end;

  -- Periodo que se factura: el pedido explicito o el vigente de la suscripcion.
  v_pstart := coalesce(p_period_start, v_sub.current_period_start::date, now()::date);

  -- Dedupe por periodo (no mira status: una factura CANCELLED/PAID del mismo
  -- periodo tambien lo bloquea; solo deleted_at lo libera).
  if exists (
    select 1 from public.payment_invoices
    where subscription_id = p_subscription_id
    and period_start = v_pstart
    and deleted_at is null
  ) then
    return null;
  end if;

  if v_plan.is_custom then
    v_base := coalesce(v_sub.custom_base_amount_cents, 0);
    select coalesce(sum(price_cents), 0) into v_modules_total
    from public.billing_subscription_modules where subscription_id = p_subscription_id;
  else
    v_base := v_plan.amount_cents;
  end if;

  if v_sub.setup_fee_billed_at is null then
    v_setup := coalesce(v_sub.setup_fee_override_cents, v_plan.setup_fee_cents, 0);
  end if;

  v_total := v_base + v_modules_total + v_setup;

  -- Negociacion sin precio todavia: nada que facturar ni activar.
  if v_plan.is_custom and v_total = 0 then
    return null;
  end if;

  -- amount_cents es integer: fallar claro ANTES de insertar nada.
  if v_total > 2147483647 then
    raise exception 'El monto de la suscripción excede el máximo facturable (% centavos, máximo 2147483647)', v_total;
  end if;

  -- Primera factura de una suscripcion PENDING_PAYMENT sin facturas previas
  -- cuyo periodo ya vencio (o no tiene): reiniciarlo (solo cuando se factura el
  -- periodo vigente, p_period_start nulo). Tras el reinicio el periodo a facturar
  -- es el nuevo.
  if p_period_start is null
     and v_sub.status = 'PENDING_PAYMENT'
     and (v_sub.current_period_end is null or v_sub.current_period_end <= now())
     and not exists (
       select 1 from public.payment_invoices
       where subscription_id = p_subscription_id and deleted_at is null
     ) then
    update public.billing_subscriptions
    set current_period_start = now(),
        current_period_end = now() + v_interval
    where id = p_subscription_id
    returning * into v_sub;
    v_pstart := v_sub.current_period_start::date;
  end if;

  -- Fin del periodo: el de la suscripcion cuando se factura el vigente; para una
  -- renovacion explicita, inicio + 1 intervalo (misma aritmetica que el avance).
  if p_period_start is null then
    v_pend := coalesce(v_sub.current_period_end::date, (v_pstart + v_interval)::date);
  else
    v_pend := (v_pstart + v_interval)::date;
  end if;

  v_first := not exists (
    select 1 from public.payment_invoices
    where subscription_id = p_subscription_id and deleted_at is null
  );
  v_due := case when v_first then now()::date else greatest(v_pstart, now()::date) end;

  v_zero_shortcut := (not v_plan.is_custom) and v_total = 0;

  insert into public.payment_invoices (
    merchant_tenant_id, payer_tenant_id, subscription_id, provider_key,
    amount_cents, currency, status, invoice_number, description, due_date,
    period_start, period_end
  ) values (
    null, v_sub.tenant_id, p_subscription_id, 'wompi',
    v_total::integer, v_plan.currency,
    case when v_zero_shortcut then 'PAID' else 'PENDING' end,
    'INV-' || to_char(now(), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6),
    v_plan.name, v_due,
    v_pstart, v_pend
  )
  returning id into v_invoice_id;

  if not v_plan.is_custom then
    insert into public.payment_invoice_items (invoice_id, description, quantity, unit_price_cents, subtotal_cents, display_order)
    values (v_invoice_id, v_plan.name, 1, v_base::integer, v_base::integer, v_order);
    v_order := v_order + 1;
  else
    if v_base > 0 then
      insert into public.payment_invoice_items (invoice_id, description, quantity, unit_price_cents, subtotal_cents, display_order)
      values (v_invoice_id, v_plan.name, 1, v_base::integer, v_base::integer, v_order);
      v_order := v_order + 1;
    end if;

    for v_mod in
      select module_key, price_cents, note
      from public.billing_subscription_modules
      where subscription_id = p_subscription_id
      order by module_key
    loop
      insert into public.payment_invoice_items (invoice_id, description, quantity, unit_price_cents, subtotal_cents, display_order)
      values (
        v_invoice_id,
        'Módulo: ' || coalesce(v_labels ->> v_mod.module_key, v_mod.module_key)
          || case when nullif(btrim(v_mod.note), '') is not null then ' — ' || btrim(v_mod.note) else '' end,
        1, v_mod.price_cents, v_mod.price_cents, v_order
      );
      v_order := v_order + 1;
    end loop;
  end if;

  if v_setup > 0 then
    insert into public.payment_invoice_items (invoice_id, description, quantity, unit_price_cents, subtotal_cents, display_order)
    values (v_invoice_id, 'Implementación — ' || v_plan.name, 1, v_setup::integer, v_setup::integer, v_order);
  end if;

  -- La implementacion se marca facturada apenas se incluye en una factura
  -- (incluso con setup = 0: la "primera factura" ya paso y no debe cobrarse
  -- despues si el superadmin sube la implementacion del plan).
  if v_sub.setup_fee_billed_at is null then
    update public.billing_subscriptions set setup_fee_billed_at = now() where id = p_subscription_id;
  end if;

  if v_zero_shortcut and v_sub.status = 'PENDING_PAYMENT' then
    update public.billing_subscriptions set status = 'ACTIVE' where id = p_subscription_id;
  end if;

  return v_invoice_id;
end;
$$;

-- Mismos privilegios que la version anterior (guarda de superadmin interna):
-- nada para PUBLIC/anon; authenticated (superadmin via la guarda) y service_role.
revoke all on function public.create_invoice_for_subscription(uuid, date) from public, anon;
grant execute on function public.create_invoice_for_subscription(uuid, date) to authenticated, service_role;
