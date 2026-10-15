-- `tax_enabled` ("calcular impuestos en las ventas") es una preferencia del
-- tenant sobre su operación, no un dato de la integración DIAN -- pasa a
-- `tenants` (2026-10-15, mismo criterio que fiscal_regime y la ciudad en
-- 20261015130000).
--
-- PASO 1 (este archivo, aditivo). El PASO 2 -- borrar la columna de
-- `tenant_dian_profile` -- NO va en este archivo: las Edge Functions que
-- empaquetan `isTenantTaxEnabled` (calculate-order, create-order,
-- pos-checkout, storefront, whatsapp-ai-tools) todavía leen el perfil hasta
-- que se redespliegan. Mientras tanto un trigger espeja el valor hacia
-- `tenant_dian_profile.tax_enabled`, para que una versión vieja de esas
-- funciones nunca lea un valor viejo.

alter table public.tenants add column if not exists tax_enabled boolean not null default false;
comment on column public.tenants.tax_enabled is 'El tenant calcula/discrimina impuestos en sus ventas. false por defecto. Antes vivía en tenant_dian_profile.';

update public.tenants t
   set tax_enabled = p.tax_enabled
  from public.tenant_dian_profile p
 where p.tenant_id = t.id and p.deleted_at is null;

-- Espejo TRANSITORIO tenants -> tenant_dian_profile (se elimina con el PASO 2).
create or replace function public.mirror_tenant_tax_enabled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.tenant_dian_profile (tenant_id, tax_enabled)
  values (new.id, new.tax_enabled)
  on conflict (tenant_id) do update
    set tax_enabled = excluded.tax_enabled
    where public.tenant_dian_profile.tax_enabled is distinct from excluded.tax_enabled;
  return new;
end;
$$;
revoke all on function public.mirror_tenant_tax_enabled() from public, anon, authenticated;

drop trigger if exists tenants_mirror_tax_enabled on public.tenants;
create trigger tenants_mirror_tax_enabled
  after update of tax_enabled on public.tenants
  for each row
  when (old.tax_enabled is distinct from new.tax_enabled)
  execute function public.mirror_tenant_tax_enabled();
