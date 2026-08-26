-- Tienda pública por tenant (marketplace) -- ver CLAUDE.md. Un link fijo y
-- reutilizable por tenant (a diferencia del link por pedido que reemplaza,
-- ver 20260826000004) para que cualquier visitante nuevo, sin ninguna
-- conversación previa, pueda navegar el catálogo y comprar.

-- Opt-in, no opt-out: ningún producto existente aparece en la tienda hasta
-- que el tenant lo marque a propósito -- mismo criterio cauteloso que
-- tenant_enabled_modules/ai_assistant_skills, que arrancan vacíos.
alter table public.products add column is_visible_in_catalog boolean not null default false;

create index products_visible_in_catalog_idx on public.products (tenant_id)
  where is_visible_in_catalog and is_active and deleted_at is null;

-- storefront_slug identifica la URL pública (/tienda/:slug) -- único
-- GLOBALMENTE (no por tenant), a diferencia de products.slug que sí es por
-- tenant. Nullable hasta que el tenant lo configure; storefront_enabled en
-- false por defecto, tener un slug cargado no alcanza para quedar accesible.
alter table public.tenants add column storefront_slug text unique
  constraint tenants_storefront_slug_format check (storefront_slug ~ '^[a-z0-9-]+$');
alter table public.tenants add column storefront_enabled boolean not null default false;

-- Carrito de invitado: existe ANTES de que haya ningún cliente identificado
-- (por eso no puede ser una fila de sales_orders, que siempre requiere un
-- contact_id). session_token vive en el localStorage del visitante -- mismo
-- rol que un token de link, pero generado en el primer add_to_cart en vez de
-- que un agente/la IA lo emita.
create table public.storefront_carts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  session_token text not null unique default encode(extensions.gen_random_bytes(32), 'hex'),
  status text not null default 'active' check (status in ('active', 'converted')),
  converted_order_id uuid references public.sales_orders(id),
  converted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index storefront_carts_tenant_idx on public.storefront_carts (tenant_id);
-- Un carrito 'active' viejo sin converted_order_id ES un carrito abandonado
-- -- esta es la consulta de esa métrica, sin trabajo extra.
create index storefront_carts_abandoned_idx on public.storefront_carts (tenant_id, created_at) where status = 'active';

alter table public.storefront_carts enable row level security;
create policy "tenant reads own storefront carts" on public.storefront_carts
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create trigger set_updated_at
  before update on public.storefront_carts
  for each row execute function public.set_updated_at();

-- Sin snapshot de precio -- el carrito es pre-venta, el precio se resuelve
-- en vivo hasta el checkout, igual que en create_quote.
create table public.storefront_cart_items (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references public.storefront_carts(id) on delete cascade,
  product_id uuid not null references public.products(id),
  variant_id uuid references public.product_variants(id),
  quantity integer not null check (quantity > 0),
  created_at timestamptz not null default now()
);

create index storefront_cart_items_cart_idx on public.storefront_cart_items (cart_id);

alter table public.storefront_cart_items enable row level security;
create policy "tenant reads own storefront cart items" on public.storefront_cart_items
  for select using (
    exists (
      select 1 from public.storefront_carts c
      where c.id = storefront_cart_items.cart_id
        and (c.tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
    )
  );

-- Verificación de teléfono por código de un solo uso (WhatsApp) antes de
-- crear/cobrar una orden -- decisión explícita del usuario: un checkout que
-- solo pidiera "teléfono" como texto libre dejaría que cualquiera se haga
-- pasar por un cliente real (grave si ese cliente tiene crédito/fiado
-- habilitado). Atada a cart_id (no solo al teléfono suelto) para que un
-- código no sirva fuera de la sesión que lo pidió.
create table public.storefront_phone_verifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  cart_id uuid not null references public.storefront_carts(id) on delete cascade,
  phone text not null,
  code text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

create index storefront_phone_verifications_cart_phone_idx on public.storefront_phone_verifications (cart_id, phone);
-- Rate limit simple (máximo N códigos por teléfono en una ventana corta) --
-- esta consulta es la que lo hace posible sin un índice sobre toda la tabla.
create index storefront_phone_verifications_phone_created_idx on public.storefront_phone_verifications (tenant_id, phone, created_at);

alter table public.storefront_phone_verifications enable row level security;
create policy "tenant reads own storefront phone verifications" on public.storefront_phone_verifications
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
