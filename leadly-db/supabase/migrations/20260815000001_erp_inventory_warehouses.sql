-- ERP pivot, Fase 1: inventario multi-bodega + kardex. Ver CLAUDE.md
-- "Estado actual (2026-08-15) — Pivote a ERP" para el contexto completo del
-- pivote. Regla dura de esta ronda: ninguna tabla crm_* se toca -- este es
-- un modelo de inventario nuevo y paralelo al contador plano
-- crm_products.stock_quantity/reserved_stock, que el flujo de ventas por
-- WhatsApp (create_quote/confirm_quote en whatsapp-ai-tools) sigue leyendo
-- y escribiendo sin ningún cambio. Si en una fase futura este modelo pasa a
-- ser la única fuente de verdad de stock, es una decisión de cutover
-- explícita aparte, no algo que esta migración asuma.

create table public.warehouses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  address text,
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

create index warehouses_tenant_id_idx on public.warehouses(tenant_id);

-- Un solo default activo por tenant.
create unique index warehouses_tenant_one_default_idx on public.warehouses(tenant_id)
  where is_default and deleted_at is null;

create trigger warehouses_set_updated_at
  before update on public.warehouses
  for each row execute function public.set_updated_at();

alter table public.warehouses enable row level security;

create policy warehouses_select on public.warehouses
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy warehouses_insert on public.warehouses
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy warehouses_update on public.warehouses
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy warehouses_delete on public.warehouses
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.warehouses from anon;

-- Stock "actual" por producto+bodega -- mantenido por el trigger del kardex
-- de abajo, nunca se escribe directo desde la app. product_id referencia
-- crm_products (tabla existente, esquema intacto).
create table public.product_stock (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id uuid not null references public.crm_products(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  quantity numeric not null default 0,
  reserved_quantity numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, warehouse_id)
);

create index product_stock_tenant_id_idx on public.product_stock(tenant_id);
create index product_stock_product_id_idx on public.product_stock(product_id);
create index product_stock_warehouse_id_idx on public.product_stock(warehouse_id);

create trigger product_stock_set_updated_at
  before update on public.product_stock
  for each row execute function public.set_updated_at();

alter table public.product_stock enable row level security;

create policy product_stock_select on public.product_stock
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy product_stock_write on public.product_stock
  for all using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.product_stock from anon;

-- Kardex: ledger append-only de todo movimiento de inventario. product_stock
-- es, en la práctica, la suma acumulada de estas filas por producto+bodega.
-- Mismo idioma que crm_notes/crm_pqr_updates: RLS habilitado, sin policy de
-- update/delete (RLS deniega por defecto lo que no tiene policy).
create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id uuid not null references public.crm_products(id) on delete restrict,
  warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  movement_type text not null check (movement_type in (
    'entrada', 'salida', 'ajuste_positivo', 'ajuste_negativo',
    'transferencia_salida', 'transferencia_entrada'
  )),
  quantity numeric not null check (quantity > 0),
  reference_type text check (reference_type in ('carga_inicial', 'compra', 'despacho', 'ajuste_manual', 'transferencia')),
  reference_id uuid,
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index stock_movements_tenant_id_idx on public.stock_movements(tenant_id);
create index stock_movements_product_id_idx on public.stock_movements(product_id);
create index stock_movements_warehouse_id_idx on public.stock_movements(warehouse_id);

alter table public.stock_movements enable row level security;

create policy stock_movements_select on public.stock_movements
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy stock_movements_insert on public.stock_movements
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.stock_movements from anon;

-- Mantiene product_stock.quantity al día a partir del kardex: entrada/
-- ajuste_positivo/transferencia_entrada suman, el resto resta. Ningún
-- movimiento toca reserved_quantity todavía -- eso lo introduce la Fase 2
-- (Despachos), cuando exista algo que reserve stock antes de despacharlo.
create or replace function public.apply_stock_movement()
returns trigger
language plpgsql
as $$
declare
  v_delta numeric;
begin
  if new.movement_type in ('entrada', 'ajuste_positivo', 'transferencia_entrada') then
    v_delta := new.quantity;
  else
    v_delta := -new.quantity;
  end if;

  insert into public.product_stock (tenant_id, product_id, warehouse_id, quantity)
  values (new.tenant_id, new.product_id, new.warehouse_id, greatest(0, v_delta))
  on conflict (product_id, warehouse_id)
  do update set quantity = greatest(0, public.product_stock.quantity + v_delta), updated_at = now();

  return new;
end;
$$;

create trigger trg_stock_movements_apply after insert on public.stock_movements
  for each row execute function public.apply_stock_movement();

-- Una "Bodega Principal" por tenant nuevo, mismo patrón que
-- seed_default_pipeline(): un tenant nunca debería llegar a "Inventario" y
-- no tener dónde registrar stock.
create or replace function public.seed_default_warehouse()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.warehouses (tenant_id, name, is_default) values (new.id, 'Bodega Principal', true);
  return new;
end;
$$;

create trigger tenants_seed_default_warehouse
  after insert on public.tenants
  for each row execute function public.seed_default_warehouse();

-- Backfill: una bodega principal por tenant existente, y una entrada
-- "carga_inicial" por cada producto con stock > 0, para que el kardex
-- arranque desde una base consistente con crm_products.stock_quantity (que
-- esta migración no toca ni referencia después de este punto).
do $$
declare
  v_tenant record;
  v_warehouse_id uuid;
  v_product record;
begin
  for v_tenant in select id from public.tenants where id not in (select tenant_id from public.warehouses) loop
    insert into public.warehouses (tenant_id, name, is_default) values (v_tenant.id, 'Bodega Principal', true)
      returning id into v_warehouse_id;

    for v_product in
      select id, stock_quantity from public.crm_products
      where tenant_id = v_tenant.id and deleted_at is null and stock_quantity > 0
    loop
      insert into public.stock_movements (tenant_id, product_id, warehouse_id, movement_type, quantity, reference_type, notes)
      values (v_tenant.id, v_product.id, v_warehouse_id, 'entrada', v_product.stock_quantity, 'carga_inicial', 'Backfill inicial del módulo de inventario');
    end loop;
  end loop;
end;
$$;

-- Habilita "inventory" en el catálogo de módulos togglables por tenant,
-- mismo patrón que 20260811000015 con "integrations". Deshabilitado por
-- defecto para todo tenant (tabla presence-based, sin backfill de filas) --
-- el superadmin lo prueba en un tenant de QA en `develop` antes de
-- ofrecerlo en producción.
alter table public.tenant_enabled_modules drop constraint tenant_enabled_modules_module_key_check;
alter table public.tenant_enabled_modules add constraint tenant_enabled_modules_module_key_check check (module_key in (
  'dashboard', 'conversations', 'contacts', 'pipeline', 'products', 'sales',
  'tasks', 'calendar', 'campaigns', 'reports', 'automations', 'aiAgents',
  'billing', 'integrations', 'inventory', 'settings'
));
