-- Planes que limitan modulos (derechos / "entitlements") + plan Enterprise con
-- precio por modulo negociado por comercio.
--
-- Contrato normativo: progress/feature_plans_entitlements.md (decision del
-- usuario 2026-10-13: "limitar los modulos segun el plan que contrate la
-- empresa, y en el enterprise que se habilite un check para negociar que cobro
-- por cada modulo").
--
-- Por que existe cada pieza
-- -------------------------
-- 1. billing_plans gana implementacion (cobro unico), limites nuevos (bodegas,
--    puntos de venta, agentes, mensajes de IA), is_custom (Enterprise: precio y
--    modulos se pactan por comercio), orden y visibilidad. max_whatsapp_lines
--    pasa a aceptar 0 ("este plan no incluye lineas"); NULL sigue siendo
--    "ilimitado". max_users se conserva (> 0 o NULL).
-- 2. billing_plan_modules: que modulos incluye un plan normal.
-- 3. billing_subscription_modules: modulos y precio mensual pactados en una
--    suscripcion de plan a medida (is_custom).
-- 4. tenant_enabled_modules.source ('manual'|'plan'|'subscription'): quien puso
--    cada modulo. GRANDFATHERING: todas las filas existentes quedan 'manual',
--    asi que aplicar esta migracion NO cambia el conjunto de modulos de ningun
--    comercio. La sincronizacion automatica solo toca filas 'plan' o
--    'subscription', nunca 'manual'.
-- 5. El CHECK de module_key se amplia con 'einvoicing' y 'storefront' (claves
--    de derecho nuevas; 'einvoicing' se habia retirado como modulo el
--    2026-09-04 y vuelve como derecho de plan, sin ruta propia).
-- 6. sync_tenant_modules_from_plan / apply_plan_to_tenant /
--    preview_apply_plan_to_tenant / get_tenant_entitlements: la logica vive en
--    la base, no en el frontend.
-- 7. create_invoice_for_subscription: monto custom, un item por linea y cobro
--    de implementacion en la primera factura de la suscripcion.
--
-- Comportamientos deliberados (revisados en progress/E1_review.md):
--  * Plan custom SIN ninguna fila en billing_subscription_modules: el sync es
--    NO-OP (conserva los modulos actuales) hasta que exista una negociacion
--    guardada. Asi cambiar un comercio a Enterprise antes de negociar no le
--    quita modulos. Consecuencia: borrar la ULTIMA fila negociada tampoco
--    retira ese modulo; para dejar un Enterprise sin modulos gestionados hay
--    que quitarlos a mano (source manual) o cambiar de plan.
--  * Un monto de factura que no cabe en integer (> 2.147.483.647 centavos, ~21,4 M
--    COP) lanza una excepcion clara ANTES de insertar nada; el cron diario aisla
--    cada suscripcion en un sub-bloque, asi una suscripcion mala no aborta el
--    lote ni revierte a las demas (se reintenta al dia siguiente).
--  * La PRIMERA factura de una suscripcion PENDING_PAYMENT sin facturas previas
--    reinicia el periodo (start=now, end=now+intervalo del plan) si su
--    current_period_end es nulo o ya paso; si no, la factura nacia vencida y
--    deactivate_tenants_with_overdue_invoices desactivaba al comercio.
--  * Un Enterprise deliberadamente en $0 (sin base, modulos ni implementacion)
--    NO se activa solo: no se emite factura (una de $0 no se puede pagar y
--    bloquearia el periodo) y el cron solo mira suscripciones ACTIVE. No hay
--    camino de UI. Activacion manual precisa: record_manual_payment exige una
--    factura, asi que NO sirve; el superadmin (RLS billing_subscriptions_
--    superadmin_update) o service_role hace
--       update public.billing_subscriptions set status = 'ACTIVE' where id = '<sub>';
--    Desde ahi el cron la renueva y no emite factura mientras el total sea 0.
--
-- Esta etapa solo MODELA y muestra los derechos; hacerlos cumplir en el backend
-- (dian-submit, tienda, WhatsApp/IA, bodegas, puntos, agentes) es Etapa 2/3.
--
-- Idempotente: se puede correr N veces. No edita migraciones anteriores.
-- No toca los planes de prueba existentes (Starter/Growth/Scale).

-- ============================================================================
-- 0. Catalogo de claves validas de modulo (una sola fuente para los 3 CHECK)
-- ============================================================================
-- Lista vigente (migracion 20260913210000, canales) + einvoicing + storefront.
create or replace function public.entitlement_module_keys() returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select array[
    'dashboard', 'conversations', 'channels', 'contacts', 'pipeline', 'products', 'sales', 'tasks',
    'calendar', 'campaigns', 'reports', 'automations', 'aiAgents', 'billing', 'integrations',
    'inventory', 'settings', 'credit', 'dispatches', 'returns', 'pos', 'expenses',
    'einvoicing', 'storefront'
  ]::text[];
$$;

revoke all on function public.entitlement_module_keys() from public, anon;
grant execute on function public.entitlement_module_keys() to authenticated, service_role;

-- ============================================================================
-- 1. billing_plans: columnas nuevas y limite de lineas relajado
-- ============================================================================
alter table public.billing_plans
  add column if not exists setup_fee_cents integer not null default 0 check (setup_fee_cents >= 0),
  add column if not exists is_custom boolean not null default false,
  add column if not exists max_warehouses integer check (max_warehouses is null or max_warehouses >= 0),
  add column if not exists max_pos_points integer check (max_pos_points is null or max_pos_points >= 0),
  add column if not exists max_ai_agents integer check (max_ai_agents is null or max_ai_agents >= 0),
  add column if not exists max_ai_messages_month integer check (max_ai_messages_month is null or max_ai_messages_month >= 0),
  add column if not exists sort_order integer not null default 0,
  add column if not exists is_public boolean not null default true;

comment on column public.billing_plans.setup_fee_cents is 'Implementacion (cobro unico, con IVA incluido como amount_cents). Se factura en la primera factura de cada suscripcion.';
comment on column public.billing_plans.is_custom is 'Plan a medida (Enterprise): precio base y modulos se pactan por suscripcion (billing_subscriptions.custom_base_amount_cents + billing_subscription_modules).';
comment on column public.billing_plans.max_warehouses is 'Maximo de bodegas. NULL = sin limite, 0 = ninguna. Solo modelado en esta etapa (sin enforcement).';
comment on column public.billing_plans.max_pos_points is 'Maximo de puntos de venta. NULL = sin limite, 0 = ninguno. Solo modelado en esta etapa.';
comment on column public.billing_plans.max_ai_agents is 'Maximo de agentes de IA. NULL = sin limite, 0 = ninguno. Solo modelado en esta etapa.';
comment on column public.billing_plans.max_ai_messages_month is 'Maximo de mensajes de IA por mes. NULL = sin limite, 0 = ninguno. Solo modelado en esta etapa.';

-- max_whatsapp_lines: antes "null o > 0" (el 0 estaba prohibido). Ahora 0 = ninguna.
alter table public.billing_plans drop constraint if exists billing_plans_max_whatsapp_lines_check;
alter table public.billing_plans
  add constraint billing_plans_max_whatsapp_lines_check
  check (max_whatsapp_lines is null or max_whatsapp_lines >= 0);

comment on column public.billing_plans.max_whatsapp_lines is 'Maximo de lineas de WhatsApp activas. NULL = sin limite, 0 = ninguna.';

-- ============================================================================
-- 2. billing_plan_modules (modulos que incluye un plan normal)
-- ============================================================================
create table if not exists public.billing_plan_modules (
  plan_id uuid not null references public.billing_plans(id) on delete cascade,
  module_key text not null,
  primary key (plan_id, module_key)
);

comment on table public.billing_plan_modules is 'Modulos incluidos en un plan normal (no is_custom). Presencia = incluido. Sin identidad de negocio propia: quitar es DELETE real.';

-- ============================================================================
-- 3. billing_subscriptions: negociacion por suscripcion
-- ============================================================================
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'billing_subscriptions' and column_name = 'setup_fee_billed_at'
  ) then
    alter table public.billing_subscriptions
      add column setup_fee_billed_at timestamptz null;

    -- GRANDFATHERING: toda suscripcion que existe hoy ya paso por su primera
    -- factura (la crea el trigger desde 20260811000011). Sin este backfill, si
    -- el superadmin le pone implementacion a un plan existente, la proxima
    -- renovacion de esas suscripciones la cobraria como "primera factura".
    -- Corre SOLO la vez que se crea la columna: una re-ejecucion no debe marcar
    -- como facturadas suscripciones nuevas que aun no tienen su primera factura.
    update public.billing_subscriptions
    set setup_fee_billed_at = created_at
    where setup_fee_billed_at is null;
  end if;
end;
$$;

alter table public.billing_subscriptions
  add column if not exists custom_base_amount_cents integer null check (custom_base_amount_cents is null or custom_base_amount_cents >= 0),
  add column if not exists setup_fee_override_cents integer null check (setup_fee_override_cents is null or setup_fee_override_cents >= 0);

comment on column public.billing_subscriptions.custom_base_amount_cents is 'Precio base mensual pactado (solo planes is_custom). Se suma a los precios de billing_subscription_modules.';
comment on column public.billing_subscriptions.setup_fee_override_cents is 'Implementacion pactada para este comercio; si es NULL aplica billing_plans.setup_fee_cents.';
comment on column public.billing_subscriptions.setup_fee_billed_at is 'Cuando se incluyo la implementacion en una factura. NULL = aun no facturada (la primera factura la cobra).';

-- ============================================================================
-- 4. billing_subscription_modules (modulos y precio de un plan a medida)
-- ============================================================================
create table if not exists public.billing_subscription_modules (
  subscription_id uuid not null references public.billing_subscriptions(id) on delete cascade,
  module_key text not null,
  price_cents integer not null default 0 check (price_cents >= 0),
  note text null,
  primary key (subscription_id, module_key)
);

comment on table public.billing_subscription_modules is 'Modulos contratados y su precio mensual en una suscripcion de plan a medida (is_custom). Presencia = contratado.';

-- ============================================================================
-- 5. tenant_enabled_modules: origen de cada modulo + claves nuevas
-- ============================================================================
alter table public.tenant_enabled_modules
  add column if not exists source text not null default 'manual'
  check (source in ('manual', 'plan', 'subscription'));

comment on column public.tenant_enabled_modules.source is 'Quien habilito el modulo: manual (superadmin a mano, nunca lo toca la sincronizacion), plan (derivado del plan) o subscription (derivado de la negociacion).';

do $$
declare
  v_keys text[] := public.entitlement_module_keys();
begin
  execute 'alter table public.tenant_enabled_modules drop constraint if exists tenant_enabled_modules_module_key_check';
  execute format(
    'alter table public.tenant_enabled_modules add constraint tenant_enabled_modules_module_key_check check (module_key = any (%L::text[]))',
    v_keys
  );

  execute 'alter table public.billing_plan_modules drop constraint if exists billing_plan_modules_module_key_check';
  execute format(
    'alter table public.billing_plan_modules add constraint billing_plan_modules_module_key_check check (module_key = any (%L::text[]))',
    v_keys
  );

  execute 'alter table public.billing_subscription_modules drop constraint if exists billing_subscription_modules_module_key_check';
  execute format(
    'alter table public.billing_subscription_modules add constraint billing_subscription_modules_module_key_check check (module_key = any (%L::text[]))',
    v_keys
  );
end;
$$;

-- ============================================================================
-- 6. RLS (mismo criterio que las tablas de billing existentes)
-- ============================================================================
alter table public.billing_plan_modules enable row level security;
alter table public.billing_subscription_modules enable row level security;

-- Los planes los puede leer cualquier autenticado (como billing_plans), asi que
-- tambien sus modulos.
drop policy if exists billing_plan_modules_select on public.billing_plan_modules;
create policy billing_plan_modules_select on public.billing_plan_modules
  for select to authenticated using (true);

drop policy if exists billing_plan_modules_superadmin_insert on public.billing_plan_modules;
create policy billing_plan_modules_superadmin_insert on public.billing_plan_modules
  for insert to authenticated with check (public.is_superadmin());
drop policy if exists billing_plan_modules_superadmin_update on public.billing_plan_modules;
create policy billing_plan_modules_superadmin_update on public.billing_plan_modules
  for update to authenticated using (public.is_superadmin()) with check (public.is_superadmin());
drop policy if exists billing_plan_modules_superadmin_delete on public.billing_plan_modules;
create policy billing_plan_modules_superadmin_delete on public.billing_plan_modules
  for delete to authenticated using (public.is_superadmin());

-- Lo negociado por un comercio es privado: superadmin o el propio comercio
-- (mismo criterio que billing_subscriptions_select).
drop policy if exists billing_subscription_modules_select on public.billing_subscription_modules;
create policy billing_subscription_modules_select on public.billing_subscription_modules
  for select to authenticated using (
    public.is_superadmin()
    or exists (
      select 1 from public.billing_subscriptions bs
      where bs.id = billing_subscription_modules.subscription_id
        and bs.tenant_id = public.auth_active_tenant_id()
    )
  );

drop policy if exists billing_subscription_modules_superadmin_insert on public.billing_subscription_modules;
create policy billing_subscription_modules_superadmin_insert on public.billing_subscription_modules
  for insert to authenticated with check (public.is_superadmin());
drop policy if exists billing_subscription_modules_superadmin_update on public.billing_subscription_modules;
create policy billing_subscription_modules_superadmin_update on public.billing_subscription_modules
  for update to authenticated using (public.is_superadmin()) with check (public.is_superadmin());
drop policy if exists billing_subscription_modules_superadmin_delete on public.billing_subscription_modules;
create policy billing_subscription_modules_superadmin_delete on public.billing_subscription_modules
  for delete to authenticated using (public.is_superadmin());

revoke all on public.billing_plan_modules from anon;
revoke all on public.billing_subscription_modules from anon;

-- ============================================================================
-- 7. Sincronizacion de modulos desde el plan
-- ============================================================================
-- Toma la suscripcion vigente del comercio (la mas reciente en ACTIVE o
-- PENDING_PAYMENT) y deja en tenant_enabled_modules, para las filas GESTIONADAS
-- (source plan/subscription), exactamente el conjunto que el plan/negociacion
-- define. NUNCA toca source = 'manual'. Sin suscripcion vigente no hace nada.
create or replace function public.sync_tenant_modules_from_plan(p_tenant_id uuid) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub record;
  v_source text;
  v_desired text[];
  v_added text[];
  v_removed text[];
  v_manual text[];
begin
  -- Serializa sincronizaciones concurrentes del mismo comercio.
  perform pg_advisory_xact_lock(hashtextextended('tenant_modules_sync:' || p_tenant_id::text, 0));

  select bs.id, bs.plan_id, bp.is_custom
    into v_sub
  from public.billing_subscriptions bs
  join public.billing_plans bp on bp.id = bs.plan_id
  where bs.tenant_id = p_tenant_id
    and bs.status in ('ACTIVE', 'PENDING_PAYMENT')
  order by bs.created_at desc, bs.id
  limit 1;

  if not found then
    return jsonb_build_object(
      'subscription_id', null, 'added', '[]'::jsonb, 'removed', '[]'::jsonb,
      'kept_manual', '[]'::jsonb, 'desired', '[]'::jsonb
    );
  end if;

  v_source := case when v_sub.is_custom then 'subscription' else 'plan' end;

  if v_sub.is_custom then
    select coalesce(array_agg(sm.module_key order by sm.module_key), '{}'::text[])
      into v_desired
    from public.billing_subscription_modules sm
    where sm.subscription_id = v_sub.id;

    -- Plan a medida sin negociacion guardada: NO-OP (no quitar modulos hasta
    -- que haya algo negociado que los reemplace).
    if cardinality(v_desired) = 0 then
      select coalesce(array_agg(module_key order by module_key), '{}'::text[])
        into v_manual
      from public.tenant_enabled_modules
      where tenant_id = p_tenant_id and source = 'manual';
      return jsonb_build_object(
        'subscription_id', v_sub.id, 'added', '[]'::jsonb, 'removed', '[]'::jsonb,
        'kept_manual', to_jsonb(v_manual), 'desired', '[]'::jsonb, 'negotiation_pending', true
      );
    end if;
  else
    select coalesce(array_agg(pm.module_key order by pm.module_key), '{}'::text[])
      into v_desired
    from public.billing_plan_modules pm
    where pm.plan_id = v_sub.plan_id;
  end if;

  with ins as (
    insert into public.tenant_enabled_modules (tenant_id, module_key, source)
    select p_tenant_id, k, v_source from unnest(v_desired) as k
    on conflict (tenant_id, module_key) do nothing
    returning module_key
  )
  select coalesce(array_agg(module_key order by module_key), '{}'::text[]) into v_added from ins;

  -- Filas gestionadas que siguen deseadas pero cambiaron de origen (el plan paso
  -- de normal a custom o viceversa): solo se re-etiquetan.
  update public.tenant_enabled_modules
  set source = v_source
  where tenant_id = p_tenant_id
    and module_key = any (v_desired)
    and source in ('plan', 'subscription')
    and source <> v_source;

  with del as (
    delete from public.tenant_enabled_modules
    where tenant_id = p_tenant_id
      and source in ('plan', 'subscription')
      and not (module_key = any (v_desired))
    returning module_key
  )
  select coalesce(array_agg(module_key order by module_key), '{}'::text[]) into v_removed from del;

  select coalesce(array_agg(module_key order by module_key), '{}'::text[])
    into v_manual
  from public.tenant_enabled_modules
  where tenant_id = p_tenant_id and source = 'manual';

  return jsonb_build_object(
    'subscription_id', v_sub.id,
    'added', to_jsonb(v_added),
    'removed', to_jsonb(v_removed),
    'kept_manual', to_jsonb(v_manual),
    'desired', to_jsonb(v_desired)
  );
end;
$$;

revoke all on function public.sync_tenant_modules_from_plan(uuid) from public, anon, authenticated;
grant execute on function public.sync_tenant_modules_from_plan(uuid) to service_role;

-- Re-sincroniza todos los comercios con una suscripcion vigente de ese plan.
create or replace function public.sync_tenants_of_plan(p_plan_id uuid) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
begin
  for v_tenant in
    select distinct bs.tenant_id
    from public.billing_subscriptions bs
    where bs.plan_id = p_plan_id and bs.status in ('ACTIVE', 'PENDING_PAYMENT')
    order by 1
  loop
    perform public.sync_tenant_modules_from_plan(v_tenant);
  end loop;
end;
$$;

revoke all on function public.sync_tenants_of_plan(uuid) from public, anon, authenticated;
grant execute on function public.sync_tenants_of_plan(uuid) to service_role;

-- ---- Disparadores ---------------------------------------------------------
-- Suscripcion creada o con plan/estado cambiado -> re-sync de ese comercio.
create or replace function public.billing_subscriptions_sync_modules_trg() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.sync_tenant_modules_from_plan(new.tenant_id);
  return new;
end;
$$;

revoke all on function public.billing_subscriptions_sync_modules_trg() from public, anon, authenticated;

drop trigger if exists billing_subscriptions_sync_modules_ins on public.billing_subscriptions;
create trigger billing_subscriptions_sync_modules_ins
  after insert on public.billing_subscriptions
  for each row execute function public.billing_subscriptions_sync_modules_trg();

drop trigger if exists billing_subscriptions_sync_modules_upd on public.billing_subscriptions;
create trigger billing_subscriptions_sync_modules_upd
  after update of plan_id, status on public.billing_subscriptions
  for each row
  when (old.plan_id is distinct from new.plan_id or old.status is distinct from new.status)
  execute function public.billing_subscriptions_sync_modules_trg();

-- billing_subscription_modules (statement-level, una sola corrida por sentencia)
create or replace function public.billing_subscription_modules_sync_new_trg() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
begin
  for v_tenant in
    select distinct bs.tenant_id
    from public.billing_subscriptions bs
    join new_rows n on n.subscription_id = bs.id
    order by 1
  loop
    perform public.sync_tenant_modules_from_plan(v_tenant);
  end loop;
  return null;
end;
$$;

create or replace function public.billing_subscription_modules_sync_old_trg() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
begin
  for v_tenant in
    select distinct bs.tenant_id
    from public.billing_subscriptions bs
    join old_rows o on o.subscription_id = bs.id
    order by 1
  loop
    perform public.sync_tenant_modules_from_plan(v_tenant);
  end loop;
  return null;
end;
$$;

create or replace function public.billing_subscription_modules_sync_upd_trg() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
begin
  for v_tenant in
    select distinct bs.tenant_id
    from public.billing_subscriptions bs
    where bs.id in (select subscription_id from new_rows union select subscription_id from old_rows)
    order by 1
  loop
    perform public.sync_tenant_modules_from_plan(v_tenant);
  end loop;
  return null;
end;
$$;

revoke all on function public.billing_subscription_modules_sync_new_trg() from public, anon, authenticated;
revoke all on function public.billing_subscription_modules_sync_old_trg() from public, anon, authenticated;
revoke all on function public.billing_subscription_modules_sync_upd_trg() from public, anon, authenticated;

drop trigger if exists billing_subscription_modules_sync_ins on public.billing_subscription_modules;
create trigger billing_subscription_modules_sync_ins
  after insert on public.billing_subscription_modules
  referencing new table as new_rows
  for each statement execute function public.billing_subscription_modules_sync_new_trg();

drop trigger if exists billing_subscription_modules_sync_upd on public.billing_subscription_modules;
create trigger billing_subscription_modules_sync_upd
  after update on public.billing_subscription_modules
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.billing_subscription_modules_sync_upd_trg();

drop trigger if exists billing_subscription_modules_sync_del on public.billing_subscription_modules;
create trigger billing_subscription_modules_sync_del
  after delete on public.billing_subscription_modules
  referencing old table as old_rows
  for each statement execute function public.billing_subscription_modules_sync_old_trg();

-- billing_plan_modules (statement-level) -> re-sync de TODOS los comercios del plan
create or replace function public.billing_plan_modules_sync_new_trg() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan uuid;
begin
  for v_plan in select distinct plan_id from new_rows order by 1 loop
    perform public.sync_tenants_of_plan(v_plan);
  end loop;
  return null;
end;
$$;

create or replace function public.billing_plan_modules_sync_old_trg() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan uuid;
begin
  for v_plan in select distinct plan_id from old_rows order by 1 loop
    perform public.sync_tenants_of_plan(v_plan);
  end loop;
  return null;
end;
$$;

create or replace function public.billing_plan_modules_sync_upd_trg() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan uuid;
begin
  for v_plan in
    select plan_id from (select plan_id from new_rows union select plan_id from old_rows) s order by 1
  loop
    perform public.sync_tenants_of_plan(v_plan);
  end loop;
  return null;
end;
$$;

revoke all on function public.billing_plan_modules_sync_new_trg() from public, anon, authenticated;
revoke all on function public.billing_plan_modules_sync_old_trg() from public, anon, authenticated;
revoke all on function public.billing_plan_modules_sync_upd_trg() from public, anon, authenticated;

drop trigger if exists billing_plan_modules_sync_ins on public.billing_plan_modules;
create trigger billing_plan_modules_sync_ins
  after insert on public.billing_plan_modules
  referencing new table as new_rows
  for each statement execute function public.billing_plan_modules_sync_new_trg();

drop trigger if exists billing_plan_modules_sync_upd on public.billing_plan_modules;
create trigger billing_plan_modules_sync_upd
  after update on public.billing_plan_modules
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.billing_plan_modules_sync_upd_trg();

drop trigger if exists billing_plan_modules_sync_del on public.billing_plan_modules;
create trigger billing_plan_modules_sync_del
  after delete on public.billing_plan_modules
  referencing old table as old_rows
  for each statement execute function public.billing_plan_modules_sync_old_trg();

-- Un plan que cambia is_custom cambia de donde salen sus modulos: re-sync.
create or replace function public.billing_plans_sync_modules_trg() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.sync_tenants_of_plan(new.id);
  return new;
end;
$$;

revoke all on function public.billing_plans_sync_modules_trg() from public, anon, authenticated;

drop trigger if exists billing_plans_sync_modules_upd on public.billing_plans;
create trigger billing_plans_sync_modules_upd
  after update of is_custom on public.billing_plans
  for each row
  when (old.is_custom is distinct from new.is_custom)
  execute function public.billing_plans_sync_modules_trg();

-- ============================================================================
-- 8. apply_plan_to_tenant / preview_apply_plan_to_tenant (solo superadmin)
-- ============================================================================
-- Vista previa del diff, SIN escribir nada.
create or replace function public.preview_apply_plan_to_tenant(p_tenant_id uuid) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub record;
  v_desired text[];
  v_existing record;
  v_to_add text[];
  v_remove_managed text[];
  v_remove_if_replace text[];
  v_manual text[];
  v_pending boolean;
begin
  if not public.is_superadmin() then
    raise exception 'Solo el superadmin puede previsualizar la aplicacion de un plan';
  end if;

  select bs.id, bs.plan_id, bp.is_custom, bp.key as plan_key
    into v_sub
  from public.billing_subscriptions bs
  join public.billing_plans bp on bp.id = bs.plan_id
  where bs.tenant_id = p_tenant_id and bs.status in ('ACTIVE', 'PENDING_PAYMENT')
  order by bs.created_at desc, bs.id
  limit 1;

  if not found then
    raise exception 'El comercio no tiene una suscripcion vigente (ACTIVE o PENDING_PAYMENT)';
  end if;

  if v_sub.is_custom then
    select coalesce(array_agg(module_key order by module_key), '{}'::text[]) into v_desired
    from public.billing_subscription_modules where subscription_id = v_sub.id;
  else
    select coalesce(array_agg(module_key order by module_key), '{}'::text[]) into v_desired
    from public.billing_plan_modules where plan_id = v_sub.plan_id;
  end if;

  v_pending := v_sub.is_custom and cardinality(v_desired) = 0;

  select coalesce(array_agg(k order by k), '{}'::text[]) into v_to_add
  from unnest(v_desired) k
  where not exists (
    select 1 from public.tenant_enabled_modules m where m.tenant_id = p_tenant_id and m.module_key = k
  );

  select coalesce(array_agg(module_key order by module_key), '{}'::text[]) into v_remove_managed
  from public.tenant_enabled_modules
  where tenant_id = p_tenant_id and source in ('plan', 'subscription') and not (module_key = any (v_desired))
    and not v_pending;

  select coalesce(array_agg(module_key order by module_key), '{}'::text[]) into v_remove_if_replace
  from public.tenant_enabled_modules
  where tenant_id = p_tenant_id and source = 'manual' and not (module_key = any (v_desired))
    and not v_pending;

  select coalesce(array_agg(module_key order by module_key), '{}'::text[]) into v_manual
  from public.tenant_enabled_modules
  where tenant_id = p_tenant_id and source = 'manual';

  return jsonb_build_object(
    'subscription_id', v_sub.id,
    'plan_key', v_sub.plan_key,
    'is_custom', v_sub.is_custom,
    'negotiation_pending', v_pending,
    'desired', to_jsonb(v_desired),
    'to_add', to_jsonb(v_to_add),
    'to_remove_managed', to_jsonb(v_remove_managed),
    'to_remove_if_replace', to_jsonb(v_remove_if_replace),
    'kept_manual', to_jsonb(v_manual)
  );
end;
$$;

revoke all on function public.preview_apply_plan_to_tenant(uuid) from public, anon;
grant execute on function public.preview_apply_plan_to_tenant(uuid) to authenticated, service_role;

-- Aplica el plan. p_replace_manual = false: agrega lo que falta y conserva los
-- 'manual'. true: ademas elimina los 'manual' que no esten en el plan y pasa a
-- 'plan'/'subscription' los 'manual' que si estan (el comercio queda
-- completamente "gestionado por plan").
create or replace function public.apply_plan_to_tenant(p_tenant_id uuid, p_replace_manual boolean default false) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
  v_desired text[];
  v_source text;
  v_removed_manual text[] := '{}';
  v_converted text[] := '{}';
begin
  if not public.is_superadmin() then
    raise exception 'Solo el superadmin puede aplicar un plan a los modulos de un comercio';
  end if;

  if not exists (
    select 1 from public.billing_subscriptions
    where tenant_id = p_tenant_id and status in ('ACTIVE', 'PENDING_PAYMENT')
  ) then
    raise exception 'El comercio no tiene una suscripcion vigente (ACTIVE o PENDING_PAYMENT)';
  end if;

  v_result := public.sync_tenant_modules_from_plan(p_tenant_id);

  if coalesce(p_replace_manual, false) and coalesce((v_result ->> 'negotiation_pending')::boolean, false) then
    raise exception 'La suscripcion es de un plan a medida sin modulos negociados; guarda la negociacion antes de reemplazar los modulos manuales';
  end if;

  if coalesce(p_replace_manual, false) then
    select coalesce(array_agg(x), '{}'::text[]) into v_desired
    from jsonb_array_elements_text(v_result -> 'desired') x;

    select case when bp.is_custom then 'subscription' else 'plan' end into v_source
    from public.billing_subscriptions bs
    join public.billing_plans bp on bp.id = bs.plan_id
    where bs.id = (v_result ->> 'subscription_id')::uuid;

    with del as (
      delete from public.tenant_enabled_modules
      where tenant_id = p_tenant_id and source = 'manual' and not (module_key = any (v_desired))
      returning module_key
    )
    select coalesce(array_agg(module_key order by module_key), '{}'::text[]) into v_removed_manual from del;

    with upd as (
      update public.tenant_enabled_modules
      set source = v_source
      where tenant_id = p_tenant_id and source = 'manual' and module_key = any (v_desired)
      returning module_key
    )
    select coalesce(array_agg(module_key order by module_key), '{}'::text[]) into v_converted from upd;

    v_result := jsonb_set(v_result, '{kept_manual}', '[]'::jsonb);
  end if;

  return v_result
    || jsonb_build_object('removed_manual', to_jsonb(v_removed_manual), 'converted_manual', to_jsonb(v_converted));
end;
$$;

revoke all on function public.apply_plan_to_tenant(uuid, boolean) from public, anon;
grant execute on function public.apply_plan_to_tenant(uuid, boolean) to authenticated, service_role;

-- ============================================================================
-- 9. get_tenant_entitlements (superadmin o el propio comercio)
-- ============================================================================
-- limits = NULL (objeto) cuando no hay suscripcion vigente; dentro de limits,
-- NULL = ilimitado y 0 = ninguno.
create or replace function public.get_tenant_entitlements(p_tenant_id uuid) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub record;
  v_modules jsonb;
begin
  if not (public.is_superadmin() or p_tenant_id = public.auth_active_tenant_id()) then
    raise exception 'No autorizado para consultar los derechos de este comercio';
  end if;

  select bs.id as sub_id, bs.status, bs.setup_fee_override_cents, bs.setup_fee_billed_at,
         bs.custom_base_amount_cents, bp.*
    into v_sub
  from public.billing_subscriptions bs
  join public.billing_plans bp on bp.id = bs.plan_id
  where bs.tenant_id = p_tenant_id and bs.status in ('ACTIVE', 'PENDING_PAYMENT')
  order by bs.created_at desc, bs.id
  limit 1;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'key', m.module_key,
             'source', m.source,
             'price_cents', case when v_sub.is_custom is true then sm.price_cents else null end
           ) order by m.module_key
         ), '[]'::jsonb)
    into v_modules
  from public.tenant_enabled_modules m
  left join public.billing_subscription_modules sm
    on sm.subscription_id = v_sub.sub_id and sm.module_key = m.module_key
  where m.tenant_id = p_tenant_id;

  if v_sub.sub_id is null then
    return jsonb_build_object(
      'plan', null, 'subscription', null, 'limits', null,
      'modules', v_modules, 'setup_fee_cents', null
    );
  end if;

  return jsonb_build_object(
    'plan', jsonb_build_object('id', v_sub.id, 'key', v_sub.key, 'name', v_sub.name, 'is_custom', v_sub.is_custom),
    'subscription', jsonb_build_object(
      'id', v_sub.sub_id, 'status', v_sub.status,
      'custom_base_amount_cents', v_sub.custom_base_amount_cents,
      'setup_fee_billed_at', v_sub.setup_fee_billed_at
    ),
    'limits', jsonb_build_object(
      'max_users', v_sub.max_users,
      'max_warehouses', v_sub.max_warehouses,
      'max_pos_points', v_sub.max_pos_points,
      'max_whatsapp_lines', v_sub.max_whatsapp_lines,
      'max_ai_agents', v_sub.max_ai_agents,
      'max_ai_messages_month', v_sub.max_ai_messages_month
    ),
    'modules', v_modules,
    'setup_fee_cents', coalesce(v_sub.setup_fee_override_cents, v_sub.setup_fee_cents)
  );
end;
$$;

revoke all on function public.get_tenant_entitlements(uuid) from public, anon;
grant execute on function public.get_tenant_entitlements(uuid) to authenticated, service_role;

-- ============================================================================
-- 10. Limite de lineas de WhatsApp: 0 = ninguna
-- ============================================================================
-- Misma logica que 20260811000007; solo cambia el mensaje cuando el tope es 0
-- (el conteo >= 0 ya rechaza siempre). NULL sigue siendo ilimitado.
-- enforce_plan_max_users NO se toca: su CHECK sigue siendo > 0 o NULL y su
-- comparacion ya trata NULL como ilimitado.
create or replace function public.enforce_plan_max_whatsapp_lines() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_became_active boolean;
  v_max integer;
  v_count integer;
begin
  if tg_op = 'INSERT' then
    v_became_active := new.status = 'active';
  else
    v_became_active := new.status = 'active' and (old.status is distinct from 'active');
  end if;

  if not v_became_active then
    return new;
  end if;

  select bp.max_whatsapp_lines into v_max
  from public.billing_subscriptions bs
  join public.billing_plans bp on bp.id = bs.plan_id
  where bs.tenant_id = new.tenant_id
  order by bs.created_at desc
  limit 1;

  if v_max is null then
    return new;
  end if;

  if v_max = 0 then
    raise exception 'Este plan no incluye líneas de WhatsApp.';
  end if;

  select count(*) into v_count
  from public.whatsapp_lines
  where tenant_id = new.tenant_id and status = 'active' and id <> new.id;

  if v_count >= v_max then
    raise exception 'Este plan permite un máximo de % líneas de WhatsApp activas.', v_max;
  end if;

  return new;
end;
$$;

-- ============================================================================
-- 11. create_invoice_for_subscription: monto custom, items por linea, implementacion
-- ============================================================================
-- Base: definicion viva de 20260811000011 (unica; ninguna migracion posterior la
-- reemplaza). Se conserva: dedupe por periodo (due_date = current_period_end),
-- numero de factura, proveedor 'wompi', y activacion inmediata de planes $0.
-- Cambios:
--  * monto: plan normal = plan.amount_cents; plan custom = custom_base_amount_cents
--    + sum(billing_subscription_modules.price_cents).
--  * items: plan normal = 1 item (como antes); custom = 1 item base (si > 0) +
--    1 por modulo. La implementacion va como item aparte.
--  * implementacion: en la primera factura de la suscripcion
--    (setup_fee_billed_at is null) se suma coalesce(override, plan.setup_fee_cents)
--    si > 0 y se fija setup_fee_billed_at.
--  * atajo "monto 0 => PAID y activa" SOLO para planes NO custom y solo si el
--    total (incluida la implementacion) es 0.
--  * plan custom con total 0 (negociacion aun sin precio): NO se crea factura
--    ni se activa. Una factura de $0 PENDING no se puede pagar por Wompi, bloquearia
--    el periodo por el dedupe y haria que deactivate_tenants_with_overdue_invoices
--    desactive al comercio. Al guardar la negociacion se vuelve a invocar la funcion.
--  * guarda de autorizacion: la funcion ahora cambia estado (setup_fee_billed_at),
--    asi que un usuario autenticado que no sea superadmin no puede invocarla. Los
--    disparadores, el cron y service_role (auth.uid() nulo) siguen funcionando.
create or replace function public.create_invoice_for_subscription(p_subscription_id uuid) returns uuid
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

  if exists (
    select 1 from public.payment_invoices
    where subscription_id = p_subscription_id
    and due_date = v_sub.current_period_end::date
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
  -- cuyo periodo ya vencio (o no tiene): reiniciarlo, para que la factura no
  -- nazca vencida y el cron horario no desactive al comercio.
  if v_sub.status = 'PENDING_PAYMENT'
     and (v_sub.current_period_end is null or v_sub.current_period_end <= now())
     and not exists (
       select 1 from public.payment_invoices
       where subscription_id = p_subscription_id and deleted_at is null
     ) then
    update public.billing_subscriptions
    set current_period_start = now(),
        current_period_end = now() + case v_plan.billing_interval
                                       when 'yearly' then interval '1 year'
                                       else interval '1 month' end
    where id = p_subscription_id
    returning * into v_sub;
  end if;

  v_zero_shortcut := (not v_plan.is_custom) and v_total = 0;

  insert into public.payment_invoices (
    merchant_tenant_id, payer_tenant_id, subscription_id, provider_key,
    amount_cents, currency, status, invoice_number, description, due_date
  ) values (
    null, v_sub.tenant_id, p_subscription_id, 'wompi',
    v_total::integer, v_plan.currency,
    case when v_zero_shortcut then 'PAID' else 'PENDING' end,
    'INV-' || to_char(now(), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6),
    v_plan.name, v_sub.current_period_end::date
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

-- Antes tenia EXECUTE para PUBLIC por defecto (sin ningun llamador desde el
-- cliente). Ahora solo superadmin (la guarda interna), el cron/triggers
-- (definer) y service_role.
revoke all on function public.create_invoice_for_subscription(uuid) from public, anon;
grant execute on function public.create_invoice_for_subscription(uuid) to authenticated, service_role;

-- ============================================================================
-- 12. process_recurring_billing_invoices: una suscripcion mala no aborta el lote
-- ============================================================================
-- Base viva: 20260811000011 (cancela las de cancel_at_period_end vencido; para
-- cada ACTIVE por vencer avanza el periodo y llama create_invoice_for_subscription).
-- Unico cambio: el trabajo de CADA suscripcion va en un sub-bloque con
-- EXCEPTION, de modo que si falla (p.ej. monto > integer) se revierte SOLO su
-- avance de periodo, se avisa con WARNING y el lote sigue; se reintenta al dia
-- siguiente. Los privilegios (revoke de 20260807173703) se conservan.
create or replace function public.process_recurring_billing_invoices() returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub record;
  v_interval interval;
begin
  update public.billing_subscriptions
  set status = 'CANCELLED', cancelled_at = now()
  where status = 'ACTIVE'
  and cancel_at_period_end = true
  and current_period_end is not null
  and current_period_end <= now();

  for v_sub in
    select bs.id, bp.billing_interval
    from public.billing_subscriptions bs
    join public.billing_plans bp on bp.id = bs.plan_id
    where bs.status = 'ACTIVE'
    and bs.cancel_at_period_end = false
    and bs.current_period_end is not null
    and bs.current_period_end <= now() + interval '3 days'
  loop
    begin
      v_interval := case v_sub.billing_interval when 'monthly' then interval '1 month' when 'yearly' then interval '1 year' end;

      update public.billing_subscriptions
      set current_period_start = current_period_end,
          current_period_end = current_period_end + v_interval
      where id = v_sub.id;

      perform public.create_invoice_for_subscription(v_sub.id);
    exception when others then
      raise warning 'process_recurring_billing_invoices: suscripcion % omitida (se reintenta mañana): %', v_sub.id, sqlerrm;
    end;
  end loop;
end;
$$;
