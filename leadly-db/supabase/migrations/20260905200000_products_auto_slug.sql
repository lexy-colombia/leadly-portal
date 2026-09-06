-- Auto-genera products.slug al crear/editar un producto cuando no viene
-- cargado a mano -- hasta ahora era un campo 100% manual que ningún flujo
-- real leía (la URL del storefront público usaba products.id, ver
-- StorefrontCatalog.tsx). Este cambio, junto con el cableado del storefront
-- (frontend + Edge Function storefront), hace que el slug se use de verdad
-- para URLs legibles del catálogo público.
create extension if not exists unaccent;

-- Normaliza texto libre a slug: sin tildes, minúsculas, solo [a-z0-9-], sin
-- guiones dobles ni en los bordes -- mismo criterio de formato
-- (^[a-z0-9-]+$) que tenants_storefront_slug_format ya exige para
-- tenants.storefront_slug.
create or replace function public.slugify_text(input text)
returns text
language sql
immutable
as $$
  select trim(both '-' from regexp_replace(lower(unaccent(coalesce(input, ''))), '[^a-z0-9]+', '-', 'g'))
$$;

-- Primer slug libre para ese tenant a partir de un slug base: el propio si
-- no colisiona, o con sufijo -2/-3/... Ignora productos soft-deleted (igual
-- que products_tenant_slug_unique, así uno eliminado no bloquea reusar su
-- slug) y a la propia fila (p_exclude_id), para poder llamarse tanto desde
-- un insert como desde un update sin chocar contra sí misma.
create or replace function public.unique_product_slug(p_tenant_id uuid, p_base_slug text, p_exclude_id uuid default null)
returns text
language plpgsql
as $$
declare
  candidate text := nullif(p_base_slug, '');
  suffix int := 1;
begin
  if candidate is null then
    candidate := 'producto';
  end if;
  while exists (
    select 1 from public.products
    where tenant_id = p_tenant_id
      and slug = candidate
      and deleted_at is null
      and (p_exclude_id is null or id <> p_exclude_id)
  ) loop
    suffix := suffix + 1;
    candidate := nullif(p_base_slug, '') || '-' || suffix;
  end loop;
  return candidate;
end;
$$;

-- Si slug viene vacío, lo deriva del nombre; si viene cargado (a mano o
-- desde una fila existente que se está actualizando), lo renormaliza al
-- mismo formato -- así el campo siempre queda válido y único sin importar
-- qué mande el caller (mismo criterio de "la DB es quien garantiza el
-- invariante" que has_permission()/los triggers seed_default_*).
create or replace function public.products_set_default_slug()
returns trigger
language plpgsql
as $$
begin
  new.slug := public.unique_product_slug(new.tenant_id, public.slugify_text(coalesce(nullif(trim(new.slug), ''), new.name)), new.id);
  return new;
end;
$$;

drop trigger if exists products_set_default_slug on public.products;
create trigger products_set_default_slug
before insert or update on public.products
for each row execute function public.products_set_default_slug();

-- Backfill: todo producto vivo sin slug (el catálogo real hoy, ver
-- CLAUDE.md -- el campo era huérfano) recibe uno generado igual, en orden
-- estable (tenant, created_at) para que las colisiones dentro de un mismo
-- tenant se desempaten siempre igual.
update public.products
set slug = slug
where deleted_at is null;
