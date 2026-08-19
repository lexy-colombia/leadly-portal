-- ERP: esquema paralelo sin prefijo "crm_", Fase 0 (modelado, sin cutover).
-- Ver 20260815010001_core_contacts.sql para el contexto completo del porqué.
--
-- Diferencia deliberada frente a crm_products (no es 1:1 acá, a propósito):
-- esta tabla NO tiene stock_quantity/reserved_stock. crm_products sí los
-- tiene (mantenidos por adjust_product_stock() desde crm_order_items), pero
-- ya existe en paralelo el modelo multi-bodega de Inventario Fase 1
-- (product_stock/stock_movements, 20260815000001, ya en producción).
-- Portar el contador plano acá recrearía la misma doble fuente de verdad
-- que Fase 1 dejó pendiente de resolver -- como products se está
-- rediseñando de cero, es la oportunidad de no repetirlo: el stock de esta
-- tabla vive únicamente en product_stock. track_inventory/low_stock_threshold
-- se mantienen porque son configuración del producto, no un contador.

create table public.product_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  description text,
  color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

create index product_categories_tenant_id_idx on public.product_categories(tenant_id);
create unique index product_categories_tenant_name_unique on public.product_categories(tenant_id, lower(name))
  where deleted_at is null;

create trigger product_categories_set_updated_at
  before update on public.product_categories
  for each row execute function public.set_updated_at();

alter table public.product_categories enable row level security;

create policy product_categories_select on public.product_categories
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy product_categories_insert on public.product_categories
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy product_categories_update on public.product_categories
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy product_categories_delete on public.product_categories
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.product_categories from anon;

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  contact_name text,
  phone text,
  email text,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

create index suppliers_tenant_id_idx on public.suppliers(tenant_id);

create trigger suppliers_set_updated_at
  before update on public.suppliers
  for each row execute function public.set_updated_at();

alter table public.suppliers enable row level security;

create policy suppliers_select on public.suppliers
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy suppliers_insert on public.suppliers
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy suppliers_update on public.suppliers
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy suppliers_delete on public.suppliers
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.suppliers from anon;

create table public.products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  description text,
  sku text,
  slug text,
  category_id uuid references public.product_categories(id) on delete set null,
  supplier_id uuid references public.suppliers(id) on delete set null,
  purchase_price numeric,
  wholesale_price numeric,
  retail_price numeric,
  currency text not null default 'COP',
  track_inventory boolean not null default true,
  low_stock_threshold integer not null default 5,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

create index products_tenant_id_idx on public.products(tenant_id);
create index products_category_id_idx on public.products(category_id);
create index products_supplier_id_idx on public.products(supplier_id);
create unique index products_tenant_sku_unique on public.products(tenant_id, sku)
  where sku is not null and deleted_at is null;
create unique index products_tenant_slug_unique on public.products(tenant_id, slug)
  where slug is not null and deleted_at is null;

create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

alter table public.products enable row level security;

create policy products_select on public.products
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy products_insert on public.products
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy products_update on public.products
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy products_delete on public.products
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.products from anon;

create table public.product_images (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  storage_path text not null,
  display_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index product_images_product_id_idx on public.product_images(product_id);

alter table public.product_images enable row level security;

create policy product_images_select on public.product_images
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy product_images_insert on public.product_images
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy product_images_delete on public.product_images
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.product_images from anon;
