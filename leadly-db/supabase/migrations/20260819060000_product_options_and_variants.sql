-- Variantes de producto (talla/color/etc.), modelo tipo Shopify: products
-- sigue siendo el "modelo" padre (nombre, categorías, imágenes generales).
-- product_options define hasta 3 ejes de variación por producto (ej.
-- "Talla" -> {S,M,L,XL}); product_variants son las combinaciones reales
-- vendibles/con stock propio (ej. "Talla: M, Color: Azul"). products gana
-- has_variants -- cuando es true, el resto del catálogo/inventario/ventas
-- (product_stock, stock_movements, product_images, sales_order_items,
-- migraciones siguientes) registra contra la variante, no contra el
-- producto -- variant_id nullable en cada una, null sigue significando
-- "sin variantes", comportamiento idéntico al de hoy.

alter table public.products
  add column has_variants boolean not null default false;

create table public.product_options (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  name text not null,
  display_order integer not null default 0,
  -- Valores en el orden que el usuario los cargó (TagInput) -- ese orden
  -- define cómo se generan las combinaciones (producto cartesiano) y cómo
  -- se listan en la UI. Sin tabla hija aparte para los valores: a
  -- diferencia de category_id, un valor de opción no tiene FKs propias --
  -- lo único que referencia un valor concreto es
  -- product_variants.option{1,2,3}_value, como snapshot de texto (ver
  -- abajo), no un id.
  values text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index product_options_tenant_id_idx on public.product_options(tenant_id);
create index product_options_product_id_idx on public.product_options(product_id);
-- Un mismo eje ("Talla") no puede repetirse dos veces en el mismo producto.
create unique index product_options_product_name_unique on public.product_options(product_id, lower(name));

create trigger product_options_set_updated_at
  before update on public.product_options
  for each row execute function public.set_updated_at();

alter table public.product_options enable row level security;

create policy product_options_select on public.product_options
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy product_options_insert on public.product_options
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy product_options_update on public.product_options
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy product_options_delete on public.product_options
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.product_options from anon;

-- Combinación vendible real -- hasta 3 ejes (option1_value/option2_value/
-- option3_value), snapshot de texto (no FK al array product_options.values,
-- que no tiene identidad propia por valor). Precios nullable a propósito:
-- null hereda el precio del producto padre -- resuelto en la capa de
-- aplicación (lib/api/products.ts), no acá, para no duplicar esa lógica en
-- SQL y en la UI. Soft-delete, mismo patrón que products.
create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  sku text,
  option1_value text,
  option2_value text,
  option3_value text,
  purchase_price numeric,
  wholesale_price numeric,
  retail_price numeric,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

create index product_variants_tenant_id_idx on public.product_variants(tenant_id);
create index product_variants_product_id_idx on public.product_variants(product_id);
create unique index product_variants_tenant_sku_unique on public.product_variants(tenant_id, sku)
  where sku is not null and deleted_at is null;
-- Misma combinación de valores no puede repetirse dos veces para el mismo
-- producto -- coalesce(...,'') a propósito: dos filas con
-- option2_value/option3_value en null (producto con un solo eje) son la
-- MISMA combinación para este chequeo, no dos filas distintas (NULL se
-- trata como "distinto de cualquier cosa, incluido otro NULL" en un índice
-- único normal -- sin el coalesce, este índice dejaría crear infinitos "M"
-- duplicados en un producto de un solo eje).
create unique index product_variants_product_combo_unique on public.product_variants(
  product_id, coalesce(option1_value, ''), coalesce(option2_value, ''), coalesce(option3_value, '')
) where deleted_at is null;

create trigger product_variants_set_updated_at
  before update on public.product_variants
  for each row execute function public.set_updated_at();

alter table public.product_variants enable row level security;

create policy product_variants_select on public.product_variants
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy product_variants_insert on public.product_variants
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy product_variants_update on public.product_variants
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy product_variants_delete on public.product_variants
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.product_variants from anon;

-- Límite de 3 ejes por producto: se valida en la UI (ProductVariantsSection
-- deshabilita "Agregar opción" al llegar a 3), no acá -- consistente con el
-- resto del esquema, que evita triggers de validación de negocio salvo
-- donde el daño de no tenerlos es alto (ver el trigger de
-- stock_movements en la migración siguiente).
