-- ERP: esquema paralelo sin prefijo "crm_", Fase 0 (modelado, sin cutover).
-- Ver 20260815010001_core_contacts.sql para el contexto completo.
--
-- 1:1 con crm_orders/crm_order_items/crm_order_payments/crm_order_comments,
-- renombrado sales_orders (no "orders" a secas) porque el ERP va a tener
-- despachos y compras a proveedor más adelante -- "orders" sin calificar es
-- ambiguo entre venta y compra.
--
-- Diferencia deliberada frente a crm_order_items (no es 1:1 acá, a
-- propósito): NO se porta el trigger adjust_product_stock()/
-- apply_order_item_stock_effect()/apply_order_status_stock_effect() de
-- crm_orders. Esa lógica asumía un contador plano en products, que esta
-- tabla ya no tiene (ver 20260815010002_core_catalog.sql). El efecto de
-- stock correcto acá es contra product_stock/stock_movements por bodega, y
-- eso depende de cómo Fase 2 (Despachos) defina la reserva de stock por
-- bodega -- construirlo ahora sería inventar una semántica que todavía no
-- se decidió. sales_order_items sí lleva warehouse_id, nullable, listo para
-- cuando ese trigger se construya. Hasta entonces, sales_orders/
-- sales_order_items no afectan product_stock -- efecto puramente de
-- catálogo/ventas, sin tocar inventario todavía.

create table public.sales_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  number integer not null,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  opportunity_id uuid references public.opportunities(id) on delete set null,
  status text not null default 'cotizacion' check (status in ('cotizacion', 'confirmada', 'en_proceso', 'entregada', 'cancelada')),
  currency text not null default 'COP',
  subtotal numeric not null default 0,
  discount_total numeric not null default 0,
  tax_total numeric not null default 0,
  shipping numeric not null default 0,
  total numeric not null default 0,
  notes text,
  valid_until date,
  shipping_address_id uuid references public.contact_addresses(id) on delete set null,
  billing_address_id uuid references public.contact_addresses(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

create index sales_orders_tenant_id_idx on public.sales_orders(tenant_id);
create index sales_orders_contact_id_idx on public.sales_orders(contact_id);
create index sales_orders_opportunity_id_idx on public.sales_orders(opportunity_id);
create unique index sales_orders_tenant_id_number_idx on public.sales_orders(tenant_id, number);

create trigger sales_orders_set_updated_at
  before update on public.sales_orders
  for each row execute function public.set_updated_at();

alter table public.sales_orders enable row level security;

create policy sales_orders_select on public.sales_orders
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy sales_orders_insert on public.sales_orders
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy sales_orders_update on public.sales_orders
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy sales_orders_delete on public.sales_orders
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.sales_orders from anon;

create or replace function public.set_order_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select coalesce(max(number), 0) + 1 into new.number
    from public.sales_orders where tenant_id = new.tenant_id;
  return new;
end;
$$;

create trigger trg_sales_orders_set_number
  before insert on public.sales_orders
  for each row execute function public.set_order_number();

create table public.sales_order_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id uuid not null references public.sales_orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  warehouse_id uuid references public.warehouses(id) on delete set null,
  product_name text not null,
  sku text,
  quantity numeric not null default 1,
  unit_price numeric not null default 0,
  discount_percentage numeric not null default 0,
  subtotal numeric not null default 0,
  display_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index sales_order_items_order_id_idx on public.sales_order_items(order_id);
create index sales_order_items_product_id_idx on public.sales_order_items(product_id);

alter table public.sales_order_items enable row level security;

create policy sales_order_items_select on public.sales_order_items
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy sales_order_items_insert on public.sales_order_items
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy sales_order_items_update on public.sales_order_items
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy sales_order_items_delete on public.sales_order_items
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.sales_order_items from anon;

create table public.sales_order_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id uuid not null references public.sales_orders(id) on delete cascade,
  method text not null check (method in ('efectivo', 'transferencia', 'tarjeta', 'otro')),
  amount numeric(14, 2) not null check (amount > 0),
  currency text not null default 'COP',
  paid_at date not null default current_date,
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

create index sales_order_payments_tenant_id_idx on public.sales_order_payments(tenant_id);
create index sales_order_payments_order_id_idx on public.sales_order_payments(order_id);

create trigger sales_order_payments_set_updated_at
  before update on public.sales_order_payments
  for each row execute function public.set_updated_at();

alter table public.sales_order_payments enable row level security;

create policy sales_order_payments_select on public.sales_order_payments
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy sales_order_payments_insert on public.sales_order_payments
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy sales_order_payments_update on public.sales_order_payments
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy sales_order_payments_delete on public.sales_order_payments
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.sales_order_payments from anon;

-- Append-only, mismo patrón que crm_order_comments.
create table public.sales_order_comments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id uuid not null references public.sales_orders(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  content text not null,
  created_by_ai boolean not null default false,
  created_at timestamptz not null default now()
);

create index sales_order_comments_order_id_idx on public.sales_order_comments(order_id);

alter table public.sales_order_comments enable row level security;

create policy sales_order_comments_select on public.sales_order_comments
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy sales_order_comments_insert on public.sales_order_comments
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.sales_order_comments from anon;

-- Mismo efecto que apply_order_confirmed_opportunity_effect() tiene hoy
-- sobre crm_orders/crm_opportunities: al confirmar una venta, la
-- oportunidad vinculada pasa a Ganado. No depende de inventario, así que sí
-- se porta ahora (a diferencia del efecto de stock, ver nota arriba).
create or replace function public.apply_sales_order_confirmed_opportunity_effect()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_won_stage_id uuid;
begin
  if new.status = 'confirmada' and old.status is distinct from new.status and new.opportunity_id is not null then
    select ps.id into v_won_stage_id
      from public.pipeline_stages ps
      join public.opportunities o on o.pipeline_id = ps.pipeline_id
      where o.id = new.opportunity_id and ps.is_won = true
      limit 1;

    if v_won_stage_id is not null then
      update public.opportunities
        set stage_id = v_won_stage_id, status = 'won'
        where id = new.opportunity_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_sales_orders_confirmed_opportunity
  after update of status on public.sales_orders
  for each row execute function public.apply_sales_order_confirmed_opportunity_effect();
