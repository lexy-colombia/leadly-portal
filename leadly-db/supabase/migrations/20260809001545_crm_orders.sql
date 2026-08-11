-- Cotizaciones y ventas: una sola entidad (crm_orders), no dos tablas
-- separadas -- una cotización que el cliente acepta se convierte en venta
-- cambiando `status`, sin duplicar ni migrar filas. Validado contra el
-- modelo de "purchases"/orders de seeri (commercials-app/lib/data/models/
-- order/order_model.dart): ahí también es una única entidad ("purchase"),
-- con QUOTED como un valor más del mismo campo de estado que las etapas de
-- entrega (PENDING/IN_PROCESS/DELIVERED/CANCELLED), no una tabla aparte --
-- el tab "Cotizado" de su UI (purchases_store.dart) filtra por ese status,
-- igual que acá. Deliberadamente mucho más simple que seeri (que además
-- maneja curvas de talla, seriales, splits de pago, retenciones, multi-
-- bodega): sin nada de eso, un tenant de Leadly no lo necesita hoy.
create table public.crm_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  number integer not null,
  contact_id uuid not null references public.crm_contacts(id) on delete cascade,
  opportunity_id uuid references public.crm_opportunities(id) on delete set null,
  status text not null default 'cotizacion' check (status in ('cotizacion', 'confirmada', 'en_proceso', 'entregada', 'cancelada')),
  currency text not null default 'COP',
  subtotal numeric not null default 0,
  discount_total numeric not null default 0,
  tax_total numeric not null default 0,
  shipping numeric not null default 0,
  total numeric not null default 0,
  notes text,
  valid_until date,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

create index crm_orders_tenant_id_idx on public.crm_orders(tenant_id);
create index crm_orders_contact_id_idx on public.crm_orders(contact_id);
create index crm_orders_opportunity_id_idx on public.crm_orders(opportunity_id);
create unique index crm_orders_tenant_id_number_idx on public.crm_orders(tenant_id, number);

-- Same per-tenant sequential-code pattern as crm_pqrs (see 20260804000017) --
-- lets a customer/agent reference "ORD-7" instead of a uuid, whichever
-- status it's currently in.
create or replace function public.set_crm_order_number()
returns trigger
language plpgsql
as $$
begin
  select coalesce(max(number), 0) + 1 into new.number from public.crm_orders where tenant_id = new.tenant_id;
  return new;
end;
$$;

create trigger trg_crm_orders_set_number before insert on public.crm_orders
  for each row execute function public.set_crm_order_number();

create trigger crm_orders_set_updated_at
  before update on public.crm_orders
  for each row execute function public.set_updated_at();

alter table public.crm_orders enable row level security;

create policy crm_orders_select on public.crm_orders
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_orders_insert on public.crm_orders
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_orders_update on public.crm_orders
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_orders_delete on public.crm_orders
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.crm_orders from anon;

-- Line items -- product_id is nullable (unlike crm_opportunities.contact_id,
-- which is always required) so a one-off line not in the catalog can still
-- be quoted; name/sku are snapshotted at add-time either way so a later
-- rename/price change on the product doesn't rewrite history on an existing
-- quote/sale, same reasoning as seeri's OrderProductModel keeping its own
-- name/sku instead of always joining live to the product.
create table public.crm_order_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id uuid not null references public.crm_orders(id) on delete cascade,
  product_id uuid references public.crm_products(id) on delete set null,
  product_name text not null,
  sku text,
  quantity numeric not null default 1,
  unit_price numeric not null default 0,
  discount_percentage numeric not null default 0,
  subtotal numeric not null default 0,
  display_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index crm_order_items_order_id_idx on public.crm_order_items(order_id);
create index crm_order_items_product_id_idx on public.crm_order_items(product_id);

alter table public.crm_order_items enable row level security;

create policy crm_order_items_select on public.crm_order_items
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_order_items_insert on public.crm_order_items
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_order_items_update on public.crm_order_items
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_order_items_delete on public.crm_order_items
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.crm_order_items from anon;
