-- PASO 2 de 20261015150000_tenant_tax_enabled.sql: `tax_enabled` deja de
-- existir en `tenant_dian_profile` (2026-10-15). Vive en `tenants`.
--
-- Precondición: calculate-order, create-order, pos-checkout, storefront,
-- whatsapp-ai-tools y dian-submit ya fueron redesplegadas leyendo
-- `tenants.tax_enabled`. Se retira también el espejo transitorio.
--
-- Guarda: este DROP no es reversible, así que se aborta si el valor del
-- tenant no coincide con el que tenía el perfil.
do $$
declare
  v_mismatch int;
begin
  select count(*) into v_mismatch
    from public.tenant_dian_profile p
    join public.tenants t on t.id = p.tenant_id
   where p.deleted_at is null and p.tax_enabled is distinct from t.tax_enabled;
  if v_mismatch > 0 then
    raise exception 'Abortado: % perfil(es) con tax_enabled distinto al del tenant', v_mismatch;
  end if;
end $$;

drop trigger if exists tenants_mirror_tax_enabled on public.tenants;
drop function if exists public.mirror_tenant_tax_enabled();

alter table public.tenant_dian_profile drop column if exists tax_enabled;
