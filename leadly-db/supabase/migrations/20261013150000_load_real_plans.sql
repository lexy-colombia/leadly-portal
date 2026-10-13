-- Carga de DATOS: los 4 planes reales de Leadly (Starter, Business, Business AI,
-- Enterprise), tal como los publica la pagina publica de lexy-web
-- (src/pages/Leadly.tsx, array `plans`; decision del usuario 2026-10-13).
-- Contrato: progress/brief_planes_reales.md. NO cambia esquema ni funciones.
--
-- 1. Los 3 planes de prueba (keys exactas 'Starter', 'GROWTH', 'SCALE') se
--    renombran a *_prueba y se ocultan. NO se tocan precio, limites ni las
--    suscripciones (plan_id intacto). El match es por key EXACTA y sensible a
--    mayusculas: tras la primera corrida esas keys ya no existen, asi que una
--    re-ejecucion no toca nada (y nunca confunde 'Starter' con el real 'starter').
-- 2. Los 4 planes reales: upsert por key.
-- 3. billing_plan_modules: Starter / Business / Business AI. Enterprise queda
--    sin filas (is_custom: modulos se negocian por suscripcion). Insertar aqui
--    dispara el re-sync de comercios con ese plan; los planes nuevos no tienen
--    suscripciones, asi que no cambia ningun tenant_enabled_modules.
-- Montos en centavos (69.900 COP = 6990000). Limites: NULL = ilimitado, 0 = ninguno.

-- 1. Planes de prueba ---------------------------------------------------------
update public.billing_plans
set key = 'starter_prueba', name = 'Starter (prueba)', is_active = false, is_public = false
where key = 'Starter';

update public.billing_plans
set key = 'growth_prueba', name = 'Growth (prueba)', is_active = false, is_public = false
where key = 'GROWTH';

update public.billing_plans
set key = 'scale_prueba', name = 'Scale (prueba)', is_active = false, is_public = false
where key = 'SCALE';

-- 2. Planes reales ------------------------------------------------------------
insert into public.billing_plans (
  key, name, description, amount_cents, currency, billing_interval, is_active, is_public,
  setup_fee_cents, is_custom, max_users, max_warehouses, max_pos_points,
  max_whatsapp_lines, max_ai_agents, max_ai_messages_month, sort_order
) values
  ('starter', 'Starter', 'Para tiendas y pequeños comercios.',
   6990000, 'COP', 'monthly', true, true, 15000000, false, 2, 1, 1, 0, 0, 0, 10),
  ('business', 'Business', 'Para negocios que quieren crecer.',
   14000000, 'COP', 'monthly', true, true, 35000000, false, 5, 2, 1, 0, 0, 0, 20),
  ('business_ai', 'Business AI', 'Configuramos un agente de IA para que sea el trabajador estrella de tu empresa.',
   29900000, 'COP', 'monthly', true, true, 90000000, false, 5, 2, 1, 1, 1, null, 30),
  ('enterprise', 'Enterprise', 'Equipos, sedes y procesos conectados.',
   0, 'COP', 'monthly', true, true, 0, true, null, null, null, null, null, null, 40)
on conflict (key) do update set
  name = excluded.name,
  description = excluded.description,
  amount_cents = excluded.amount_cents,
  currency = excluded.currency,
  billing_interval = excluded.billing_interval,
  is_active = excluded.is_active,
  is_public = excluded.is_public,
  setup_fee_cents = excluded.setup_fee_cents,
  is_custom = excluded.is_custom,
  max_users = excluded.max_users,
  max_warehouses = excluded.max_warehouses,
  max_pos_points = excluded.max_pos_points,
  max_whatsapp_lines = excluded.max_whatsapp_lines,
  max_ai_agents = excluded.max_ai_agents,
  max_ai_messages_month = excluded.max_ai_messages_month,
  sort_order = excluded.sort_order;

-- 3. Modulos incluidos --------------------------------------------------------
-- Starter
insert into public.billing_plan_modules (plan_id, module_key)
select p.id, m
from public.billing_plans p,
     unnest(array['dashboard','products','inventory','sales','pos','contacts','credit',
                  'expenses','returns','reports','settings','billing']::text[]) m
where p.key in ('starter', 'business', 'business_ai')
on conflict (plan_id, module_key) do nothing;

-- Business = Starter + dispatches, einvoicing, storefront, integrations
insert into public.billing_plan_modules (plan_id, module_key)
select p.id, m
from public.billing_plans p,
     unnest(array['dispatches','einvoicing','storefront','integrations']::text[]) m
where p.key in ('business', 'business_ai')
on conflict (plan_id, module_key) do nothing;

-- Business AI = Business + conversations, channels, aiAgents
insert into public.billing_plan_modules (plan_id, module_key)
select p.id, m
from public.billing_plans p,
     unnest(array['conversations','channels','aiAgents']::text[]) m
where p.key = 'business_ai'
on conflict (plan_id, module_key) do nothing;

-- Enterprise: sin filas a proposito (modulos y precio se pactan por suscripcion).
