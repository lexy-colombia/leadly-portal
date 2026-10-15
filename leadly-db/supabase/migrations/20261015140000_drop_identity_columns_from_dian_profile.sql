-- PASO 2 de 20261015130000: `tenant_dian_profile` queda solo con la
-- configuración propia de la emisión. Régimen fiscal, autorretenedor y
-- ciudad/departamento viven en `tenants` (2026-10-15).
--
-- Precondiciones (verificadas antes de escribir esto):
--   * dian-submit, send-document-email y sales-invoice-pdf ya fueron
--     desplegadas leyendo de `tenants`.
--   * apply_sales_order_confirmed_effects ya lee de `tenants`
--     (20261015130000).
--   * Ninguna vista, índice ni otra función depende de estas columnas.
--
-- Guarda: si algún perfil tuviera un dato que `tenants` no tiene, se aborta
-- antes de borrar nada -- este DROP no es reversible.
do $$
declare
  v_lost int;
begin
  select count(*) into v_lost
    from public.tenant_dian_profile p
    join public.tenants t on t.id = p.tenant_id
   where p.deleted_at is null
     and (
       (p.fiscal_regime is not null and t.fiscal_regime is null)
       or (p.is_self_withholding_agent and not t.is_self_withholding_agent)
       or (p.city_code is not null and t.city_code is null)
       or (p.state_code is not null and t.state_code is null)
     );
  if v_lost > 0 then
    raise exception 'Abortado: % perfil(es) DIAN tienen identidad fiscal que tenants aún no tiene', v_lost;
  end if;
end $$;

alter table public.tenant_dian_profile
  drop column if exists fiscal_regime,
  drop column if exists is_self_withholding_agent,
  drop column if exists city,
  drop column if exists city_code,
  drop column if exists state_code;
