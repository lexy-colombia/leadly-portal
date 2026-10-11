-- Reconciliación de drift (S1 de feature_invoicing_api, 2026-10-09).
--
-- `public.tenant_dian_profile.test_set_id` y `.webservice_url` EXISTEN en la
-- base real (el código los lee: sendInvoiceToDian.ts, getDianStatus.ts,
-- getNumberingRange.ts, y la UI de Integraciones los escribe) pero ninguna
-- migración del repo los crea -- se agregaron a mano en su momento. Un
-- `supabase db reset` / una base nueva quedaba sin ellas y el motor fallaba.
--
-- Esta migración solo hace que el repo describa lo que la base ya tiene.
-- `add column if not exists` => NO-OP en producción (las columnas ya están),
-- y crea las columnas en cualquier base reconstruida desde cero.
--
-- Tipo `text` en ambas: juicio (el código las trata como string: URL del web
-- service y GUID del set de pruebas). Si en producción ya existen con otro
-- tipo, `if not exists` no las toca, así que no hay riesgo de alteración.
--
-- Debe aplicarse ANTES de 20261009180200_invoicing_backfill_from_legacy.sql,
-- que lee ambas columnas.

alter table public.tenant_dian_profile
  add column if not exists test_set_id text,
  add column if not exists webservice_url text;
