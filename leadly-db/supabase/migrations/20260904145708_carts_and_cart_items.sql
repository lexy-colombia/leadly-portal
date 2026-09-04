-- Carrito real como etapa de pre-pedido, usado por Órdenes del portal Y
-- por el POS por igual. calculate-order (Edge Function) escribe acá
-- cuando no hay order_id -- nunca toca sales_orders directamente.
-- create-order (Edge Function nueva) es el único lugar que sí crea la
-- fila real de sales_orders, a partir de un carrito.
--
-- Sin soft-delete a propósito: un carrito cancelado o abandonado nunca
-- llegó a ser un pedido, así que no hay nada que guardar con trazabilidad
-- (decisión explícita del usuario, 2026-09-04).
create table public.carts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid references public.clients(id),
  opportunity_id uuid references public.opportunities(id),
  notes text,
  valid_until date,
  shipping_address_id uuid references public.contact_addresses(id),
  billing_address_id uuid references public.contact_addresses(id),
  shipping numeric not null default 0,
  origin text not null check (origin in ('portal', 'pos')),
  status text not null default 'open' check (status in ('open', 'converted')),
  pos_point_id uuid references public.pos_points(id) on delete set null,
  label text,
  converted_order_id uuid,
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Sin impuesto resuelto en los ítems del carrito -- eso se calcula una
-- sola vez, en create-order, con el mismo criterio que ya usa
-- persistOrderItems (nunca una segunda copia de ese cálculo).
create table public.cart_items (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references public.carts(id) on delete cascade,
  product_id uuid references public.products(id),
  variant_id uuid references public.product_variants(id),
  warehouse_id uuid references public.warehouses(id),
  product_name text not null,
  sku text,
  quantity numeric not null check (quantity > 0),
  unit_price numeric not null,
  discount_amount numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index carts_tenant_id_idx on public.carts(tenant_id);
create index carts_open_idx on public.carts(tenant_id, origin) where status = 'open';
create index cart_items_cart_id_idx on public.cart_items(cart_id);

create trigger carts_set_updated_at before update on public.carts
  for each row execute function public.set_updated_at();
create trigger cart_items_set_updated_at before update on public.cart_items
  for each row execute function public.set_updated_at();

alter table public.carts enable row level security;
alter table public.cart_items enable row level security;

create policy carts_select on public.carts
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy carts_insert on public.carts
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy carts_update on public.carts
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy carts_delete on public.carts
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy cart_items_select on public.cart_items
  for select using (exists (select 1 from public.carts c where c.id = cart_items.cart_id and (c.tenant_id = public.auth_active_tenant_id() or public.is_superadmin())));
create policy cart_items_insert on public.cart_items
  for insert with check (exists (select 1 from public.carts c where c.id = cart_items.cart_id and (c.tenant_id = public.auth_active_tenant_id() or public.is_superadmin())));
create policy cart_items_update on public.cart_items
  for update using (exists (select 1 from public.carts c where c.id = cart_items.cart_id and (c.tenant_id = public.auth_active_tenant_id() or public.is_superadmin())))
  with check (exists (select 1 from public.carts c where c.id = cart_items.cart_id and (c.tenant_id = public.auth_active_tenant_id() or public.is_superadmin())));
create policy cart_items_delete on public.cart_items
  for delete using (exists (select 1 from public.carts c where c.id = cart_items.cart_id and (c.tenant_id = public.auth_active_tenant_id() or public.is_superadmin())));

revoke all on public.carts from anon;
revoke all on public.cart_items from anon;
