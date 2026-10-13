-- Elimina los 3 planes de PRUEBA de public.billing_plans y las suscripciones que
-- apuntan a ellos. Decision del usuario (2026-10-13): "elimina los de prueba, eso
-- no existe".
--
-- Planes (key EXACTA, fijada; nunca por criterio amplio):
--   starter_prueba, growth_prueba, scale_prueba
-- (renombrados por 20261013150000_load_real_plans.sql). Respaldo previo:
-- progress/backups/planes_prueba_2026-10-13.json.
--
-- Suscripciones: solo las del tenant de pruebas TecnoNova
-- (cb195047-8cd2-4e38-9964-62bb99911814) sobre esos planes. billing_subscriptions.plan_id
-- es ON DELETE RESTRICT, por eso se borran primero.
--
-- Efectos en cascada / triggers (verificado en 20261013130000_plans_entitlements.sql):
--   * billing_subscriptions NO tiene trigger de DELETE (solo insert y update of
--     plan_id/status): borrar suscripciones no dispara sync de modulos.
--   * billing_subscription_modules (ON DELETE CASCADE): se aborta si existiera alguna
--     fila (hay 0); su trigger de delete solo llama sync_tenant_modules_from_plan, que
--     sin suscripcion vigente es no-op y NUNCA toca source='manual'.
--   * billing_plan_modules (ON DELETE CASCADE): los planes de prueba no tienen
--     modulos; el trigger de delete itera sync_tenants_of_plan(plan) sobre
--     suscripciones vigentes de ese plan -> ya borradas, cero iteraciones.
--   * payment_invoices.subscription_id es ON DELETE SET NULL: la guarda aborta si
--     existe alguna factura asociada, asi que nunca se desvincula nada.
--
-- NO se tocan: los 4 planes reales (starter, business, business_ai, enterprise),
-- tenant_enabled_modules, ni ninguna otra tabla.
--
-- Idempotente (segunda corrida: nada que borrar). Aborta sin borrar nada si el
-- estado cambio respecto de lo verificado.
do $$
declare
  v_keys constant text[] := array['starter_prueba', 'growth_prueba', 'scale_prueba'];
  v_tenant constant uuid := 'cb195047-8cd2-4e38-9964-62bb99911814';
  v_plan_ids uuid[];
  v_bad int;
  v_subs int;
  v_plans int;
begin
  select coalesce(array_agg(id), '{}'::uuid[]) into v_plan_ids
  from public.billing_plans where key = any (v_keys);

  if cardinality(v_plan_ids) = 0 then
    raise notice 'delete_test_plans: los planes de prueba ya no existen; nada que hacer';
    return;
  end if;

  -- Guarda 1: suscripciones de otro tenant.
  select count(*) into v_bad
  from public.billing_subscriptions
  where plan_id = any (v_plan_ids) and tenant_id is distinct from v_tenant;
  if v_bad > 0 then
    raise exception 'delete_test_plans: % suscripcion(es) de planes de prueba pertenecen a un tenant distinto de TecnoNova; no se borra nada', v_bad;
  end if;

  -- Guarda 2: facturas asociadas.
  select count(*) into v_bad
  from public.payment_invoices pi
  join public.billing_subscriptions bs on bs.id = pi.subscription_id
  where bs.plan_id = any (v_plan_ids);
  if v_bad > 0 then
    raise exception 'delete_test_plans: % factura(s) asociadas a suscripciones de planes de prueba; no se borra nada', v_bad;
  end if;

  -- Guarda 3 (defensa extra): negociacion guardada en esas suscripciones.
  select count(*) into v_bad
  from public.billing_subscription_modules sm
  join public.billing_subscriptions bs on bs.id = sm.subscription_id
  where bs.plan_id = any (v_plan_ids);
  if v_bad > 0 then
    raise exception 'delete_test_plans: % modulo(s) negociado(s) en suscripciones de planes de prueba; no se borra nada', v_bad;
  end if;

  delete from public.billing_subscriptions
  where plan_id = any (v_plan_ids) and tenant_id = v_tenant;
  get diagnostics v_subs = row_count;

  delete from public.billing_plans where key = any (v_keys);
  get diagnostics v_plans = row_count;

  raise notice 'delete_test_plans: % suscripcion(es) y % plan(es) de prueba eliminados', v_subs, v_plans;
end;
$$;
