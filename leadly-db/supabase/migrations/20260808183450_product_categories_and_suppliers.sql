-- Two small catalog entities Productos needed and didn't have: real
-- categories (crm_products.category was free text, no way to create/rename
-- one from the UI) and a single supplier per product ("todo debe ser por
-- proveedor" -- kept deliberately simple: one crm_suppliers table + an
-- optional supplier_id on the product, not seeri's full multi-supplier
-- product_suppliers bridge with per-supplier pricing/stock -- no real case
-- yet for one product sourced from several suppliers at once).
create table public.crm_product_categories (
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

create index crm_product_categories_tenant_id_idx on public.crm_product_categories(tenant_id);
create unique index crm_product_categories_tenant_name_unique on public.crm_product_categories(tenant_id, lower(name))
  where deleted_at is null;

create trigger crm_product_categories_set_updated_at
  before update on public.crm_product_categories
  for each row execute function public.set_updated_at();

alter table public.crm_product_categories enable row level security;

create policy crm_product_categories_select on public.crm_product_categories
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_product_categories_insert on public.crm_product_categories
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_product_categories_update on public.crm_product_categories
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_product_categories_delete on public.crm_product_categories
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.crm_product_categories from anon;

create table public.crm_suppliers (
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

create index crm_suppliers_tenant_id_idx on public.crm_suppliers(tenant_id);

create trigger crm_suppliers_set_updated_at
  before update on public.crm_suppliers
  for each row execute function public.set_updated_at();

alter table public.crm_suppliers enable row level security;

create policy crm_suppliers_select on public.crm_suppliers
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_suppliers_insert on public.crm_suppliers
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_suppliers_update on public.crm_suppliers
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_suppliers_delete on public.crm_suppliers
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.crm_suppliers from anon;

-- crm_products.category was a free-text column with zero rows written to it
-- yet (Productos shipped without any real usage in between) -- safe to
-- replace outright with a real FK instead of a parallel migrated column.
alter table public.crm_products drop column category;
alter table public.crm_products
  add column category_id uuid references public.crm_product_categories(id) on delete set null,
  add column supplier_id uuid references public.crm_suppliers(id) on delete set null;

create index crm_products_category_id_idx on public.crm_products(category_id);
create index crm_products_supplier_id_idx on public.crm_products(supplier_id);
