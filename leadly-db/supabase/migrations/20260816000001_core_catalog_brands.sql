-- Esquema ERP sin prefijo, catálogo: agrega "marca" como entidad propia,
-- adaptando el modelo de Desktop/Seeri/products (BrandDTO/embedded Brand en
-- ProductEntity: brand_id/brand_name/brand_priority). Se deja fuera
-- deliberadamente todo lo específico de marketplace que trae Seeri
-- (banners, logo, límites de compra por marca, descuentos escalonados,
-- "featured") -- Leadly no es un marketplace multi-proveedor, cada tenant
-- gestiona su propio catálogo. Mismo patrón que product_categories.

create table public.brands (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  logo_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

create index brands_tenant_id_idx on public.brands(tenant_id);
create unique index brands_tenant_name_unique on public.brands(tenant_id, lower(name))
  where deleted_at is null;

create trigger brands_set_updated_at
  before update on public.brands
  for each row execute function public.set_updated_at();

alter table public.brands enable row level security;

create policy brands_select on public.brands
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy brands_insert on public.brands
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy brands_update on public.brands
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy brands_delete on public.brands
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.brands from anon;

alter table public.products add column brand_id uuid references public.brands(id) on delete set null;
create index products_brand_id_idx on public.products(brand_id);
