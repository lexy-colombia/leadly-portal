-- Product catalog + inventory, tenant-scoped -- didn't exist at all before
-- this. Kept intentionally simpler than a full ERP (no warehouses, no
-- suppliers, no per-unit serials/kits/variants): a tenant here is a small
-- WhatsApp-driven business, not a multi-warehouse retailer, so stock lives
-- as one quantity per product with a low-stock threshold, not a movements
-- ledger. Distinct from the "Catálogo" nav item (still LockedFeature) --
-- that one is reserved for Meta's native WhatsApp Catalog API integration,
-- a different, unrelated feature; this is the tenant's own product/inventory
-- data, surfaced under a new "Productos" nav item.
create table public.crm_products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  description text,
  sku text,
  slug text,
  category text,
  -- Three price points, same distinction seeri's product catalog uses:
  -- what the tenant pays to acquire the product, what it charges a
  -- wholesale/reseller buyer, and what it charges a retail/end customer.
  -- All nullable -- a tenant might only track the one it actually sells at.
  purchase_price numeric,
  wholesale_price numeric,
  retail_price numeric,
  currency text not null default 'COP',
  track_inventory boolean not null default true,
  stock_quantity integer not null default 0,
  low_stock_threshold integer not null default 5,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

create index crm_products_tenant_id_idx on public.crm_products(tenant_id);
create index crm_products_category_idx on public.crm_products(tenant_id, category);

-- Partial (not plain) unique indexes: sku/slug are optional, and a
-- soft-deleted product shouldn't block reusing its code/slug for a new one.
create unique index crm_products_tenant_sku_unique on public.crm_products(tenant_id, sku)
  where sku is not null and deleted_at is null;
create unique index crm_products_tenant_slug_unique on public.crm_products(tenant_id, slug)
  where slug is not null and deleted_at is null;

create trigger crm_products_set_updated_at
  before update on public.crm_products
  for each row execute function public.set_updated_at();

alter table public.crm_products enable row level security;

create policy crm_products_select on public.crm_products
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_products_insert on public.crm_products
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_products_update on public.crm_products
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_products_delete on public.crm_products
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.crm_products from anon;

-- Product photos -- a catalog needs more than one image per product
-- (front/back/detail), so this is its own ordered table instead of a
-- single image_url column on crm_products.
create table public.crm_product_images (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id uuid not null references public.crm_products(id) on delete cascade,
  storage_path text not null,
  display_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index crm_product_images_product_id_idx on public.crm_product_images(product_id);

alter table public.crm_product_images enable row level security;

create policy crm_product_images_select on public.crm_product_images
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_product_images_insert on public.crm_product_images
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_product_images_delete on public.crm_product_images
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.crm_product_images from anon;

-- Public bucket (same choice as tenant-logos, unlike the private
-- crm-attachments): a product photo needs to be linkable directly -- shown
-- in the catalog UI and, later, sent as a WhatsApp image message -- without
-- generating a signed URL per view.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 5242880, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

create policy product_images_storage_read on storage.objects
  for select using (bucket_id = 'product-images');

create policy product_images_storage_write on storage.objects
  for insert with check (
    bucket_id = 'product-images'
    and (public.is_superadmin() or (storage.foldername(name))[1] = public.auth_active_tenant_id()::text)
  );

create policy product_images_storage_delete on storage.objects
  for delete using (
    bucket_id = 'product-images'
    and (public.is_superadmin() or (storage.foldername(name))[1] = public.auth_active_tenant_id()::text)
  );
