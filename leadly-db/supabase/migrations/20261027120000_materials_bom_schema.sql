-- Insumos (materials) + ficha técnica (product_bom) + modo de inventario del
-- producto. PARTE 1: esquema, RLS, módulo `materials`, permisos y kardex de
-- insumos. La parte 2 (20261027130000) engancha la venta, las reservas y la
-- disponibilidad.
--
-- Contrato: progress/contract_A_insumos.md. Decisiones:
--   * Los insumos viven en su propia tabla; `products` NO se toca salvo la
--     columna `inventory_mode` ('stock' = como hoy, 'recipe' = sin stock propio:
--     al vender descuenta los insumos de su ficha).
--   * Una unidad por insumo, cantidades decimales, SIN conversión de unidades.
--   * Kardex propio (`material_movements`, append-only) + `material_stock` por
--     bodega mantenido por trigger (mismo patrón que stock_movements /
--     product_stock). El trigger recorta a 0 con greatest(0, ...) igual que
--     apply_stock_movement (así un insumo nunca queda negativo), pero a
--     diferencia de aquél AVISA (RAISE WARNING) cuando recorta, para que el
--     desalineo kardex <-> existencias no sea silencioso.
--   * Un producto 'recipe' siempre queda con track_inventory = true (trigger):
--     así todo lector que hoy decide "este producto se controla" (tienda, IA,
--     findStockShortfalls) lo sigue tratando como controlado, y su disponible
--     sale de los insumos (parte 2).

-- ---------------------------------------------------------------------------
-- 1. products.inventory_mode
-- ---------------------------------------------------------------------------
alter table public.products
  add column inventory_mode text not null default 'stock'
  check (inventory_mode in ('stock', 'recipe'));

comment on column public.products.inventory_mode is
  'stock = inventario propio (comportamiento de siempre). recipe = sin stock propio: al vender descuenta los insumos de su ficha técnica (product_bom). Un producto recipe queda siempre con track_inventory = true.';

create or replace function public.products_force_tracked_when_recipe()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.inventory_mode = 'recipe' then
    -- v1: la ficha técnica es por producto, no por variante.
    if new.has_variants then
      raise exception 'Un producto con variantes no puede usar ficha técnica (modo recipe) en esta versión.' using errcode = 'LX422';
    end if;
    new.track_inventory := true;
  end if;
  return new;
end;
$$;

create trigger products_force_tracked_when_recipe
  before insert or update of inventory_mode, track_inventory, has_variants on public.products
  for each row execute function public.products_force_tracked_when_recipe();

-- Al pasar un producto a 'recipe' sus reservas de stock propio dejan de tener
-- sentido (las de insumos aparecen en la siguiente edición del carrito).
create or replace function public.products_release_stock_reservations_on_recipe()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.stock_reservations where product_id = new.id and tenant_id = new.tenant_id;
  return new;
end;
$$;

create trigger products_release_stock_reservations_on_recipe
  after update of inventory_mode on public.products
  for each row
  when (old.inventory_mode is distinct from new.inventory_mode and new.inventory_mode = 'recipe')
  execute function public.products_release_stock_reservations_on_recipe();

-- ---------------------------------------------------------------------------
-- 2. materials
-- ---------------------------------------------------------------------------
create table public.materials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (length(btrim(name)) > 0),
  sku text,
  unit text not null check (unit in ('un', 'kg', 'g', 'l', 'ml', 'm', 'cm', 'm2')),
  cost numeric(14,4) not null default 0 check (cost >= 0),
  min_stock numeric(14,4) check (min_stock is null or min_stock >= 0),
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

comment on table public.materials is
  'Insumos del tenant (ingredientes / materia prima). Inventario SEPARADO del de productos terminados. cost = costo unitario informativo.';

create index materials_tenant_id_idx on public.materials(tenant_id);
create unique index materials_tenant_name_unique on public.materials(tenant_id, lower(name))
  where deleted_at is null;

create trigger materials_set_updated_at
  before update on public.materials
  for each row execute function public.set_updated_at();

alter table public.materials enable row level security;
create policy materials_select on public.materials
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy materials_insert on public.materials
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy materials_update on public.materials
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy materials_delete on public.materials
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
revoke all on public.materials from anon;

-- ---------------------------------------------------------------------------
-- 3. material_stock (solo lectura para usuarios; lo mantiene el trigger)
-- ---------------------------------------------------------------------------
create table public.material_stock (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  material_id uuid not null references public.materials(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  quantity numeric(14,4) not null default 0 check (quantity >= 0),
  updated_at timestamptz not null default now(),
  primary key (material_id, warehouse_id)
);

create index material_stock_tenant_idx on public.material_stock(tenant_id, material_id);

alter table public.material_stock enable row level security;
create policy material_stock_select on public.material_stock
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
revoke all on public.material_stock from anon;
revoke insert, update, delete, truncate on public.material_stock from authenticated;

-- ---------------------------------------------------------------------------
-- 4. material_movements (kardex append-only)
-- ---------------------------------------------------------------------------
create table public.material_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  material_id uuid not null references public.materials(id) on delete restrict,
  warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  movement_type text not null
    check (movement_type in ('entrada', 'salida', 'ajuste_positivo', 'ajuste_negativo', 'carga_inicial')),
  quantity numeric(14,4) not null check (quantity > 0),
  unit_cost numeric(14,4) check (unit_cost is null or unit_cost >= 0),
  reference_type text
    check (reference_type is null or reference_type in ('carga_inicial', 'compra', 'venta', 'ajuste_manual', 'devolucion', 'produccion')),
  reference_id uuid,
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index material_movements_tenant_material_idx on public.material_movements(tenant_id, material_id, created_at desc);
create index material_movements_reference_idx on public.material_movements(reference_id) where reference_id is not null;

alter table public.material_movements enable row level security;
create policy material_movements_select on public.material_movements
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
-- Los usuarios solo registran movimientos MANUALES (carga inicial, compra,
-- ajuste). Los de venta/producción los escriben triggers y funciones del
-- servidor (security definer / service_role): así nadie fabrica un
-- reference_type 'venta' que la cancelación de un pedido luego revertiría.
create policy material_movements_insert on public.material_movements
  for insert with check (
    (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
    and reference_type in ('carga_inicial', 'compra', 'ajuste_manual')
  );
revoke all on public.material_movements from anon;
revoke update, delete, truncate on public.material_movements from authenticated;

-- Validación previa: el insumo y la bodega pertenecen al tenant del movimiento
-- (ningún FK compuesto lo garantiza) y created_by no se falsifica.
create or replace function public.material_movements_validate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.materials m where m.id = new.material_id and m.tenant_id = new.tenant_id) then
    raise exception 'El insumo no pertenece a este tenant.' using errcode = 'LX403';
  end if;
  if not exists (select 1 from public.warehouses w where w.id = new.warehouse_id and w.tenant_id = new.tenant_id) then
    raise exception 'La bodega no pertenece a este tenant.' using errcode = 'LX403';
  end if;
  if auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

create trigger material_movements_validate
  before insert on public.material_movements
  for each row execute function public.material_movements_validate();

-- Mantiene material_stock. greatest(0, ...) = mismo recorte que
-- apply_stock_movement: el kardex registra la cantidad completa pero la
-- existencia nunca baja de 0. Diferencia deliberada: acá se emite un WARNING
-- cuando el recorte ocurre (visible en los logs de Postgres), para que un
-- desalineo no sea completamente silencioso.
create or replace function public.apply_material_movement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delta numeric;
  v_current numeric;
begin
  v_delta := case
    when new.movement_type in ('entrada', 'ajuste_positivo', 'carga_inicial') then new.quantity
    else -new.quantity
  end;

  select ms.quantity into v_current
    from public.material_stock ms
   where ms.material_id = new.material_id and ms.warehouse_id = new.warehouse_id
     for update;
  v_current := coalesce(v_current, 0);

  if v_current + v_delta < 0 then
    raise warning 'material_stock recortado a 0: insumo % bodega % existencia % movimiento % (kardex %)',
      new.material_id, new.warehouse_id, v_current, v_delta, new.id;
  end if;

  insert into public.material_stock (tenant_id, material_id, warehouse_id, quantity)
  values (new.tenant_id, new.material_id, new.warehouse_id, greatest(0, v_delta))
  on conflict (material_id, warehouse_id)
  do update set quantity = greatest(0, public.material_stock.quantity + v_delta), updated_at = now();

  return new;
end;
$$;

create trigger material_movements_apply
  after insert on public.material_movements
  for each row execute function public.apply_material_movement();

-- ---------------------------------------------------------------------------
-- 5. product_bom (ficha técnica)
-- ---------------------------------------------------------------------------
create table public.product_bom (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  material_id uuid not null references public.materials(id) on delete cascade,
  quantity numeric(14,4) not null check (quantity > 0),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, material_id)
);

comment on table public.product_bom is
  'Ficha técnica: cantidad de cada insumo (en SU unidad) que consume UNA unidad vendida del producto. Borrado real (es una lista de configuración, no un registro de negocio).';

create index product_bom_tenant_material_idx on public.product_bom(tenant_id, material_id);

create trigger product_bom_set_updated_at
  before update on public.product_bom
  for each row execute function public.set_updated_at();

create or replace function public.product_bom_validate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.products p where p.id = new.product_id and p.tenant_id = new.tenant_id) then
    raise exception 'El producto no pertenece a este tenant.' using errcode = 'LX403';
  end if;
  if not exists (select 1 from public.materials m where m.id = new.material_id and m.tenant_id = new.tenant_id) then
    raise exception 'El insumo no pertenece a este tenant.' using errcode = 'LX403';
  end if;
  return new;
end;
$$;

create trigger product_bom_validate
  before insert or update on public.product_bom
  for each row execute function public.product_bom_validate();

alter table public.product_bom enable row level security;
create policy product_bom_select on public.product_bom
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy product_bom_insert on public.product_bom
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy product_bom_update on public.product_bom
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy product_bom_delete on public.product_bom
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
revoke all on public.product_bom from anon;

-- ---------------------------------------------------------------------------
-- 6. Privilegios de las funciones de trigger (security definer)
-- ---------------------------------------------------------------------------
revoke execute on function public.products_release_stock_reservations_on_recipe() from public, anon, authenticated;
revoke execute on function public.material_movements_validate() from public, anon, authenticated;
revoke execute on function public.apply_material_movement() from public, anon, authenticated;
revoke execute on function public.product_bom_validate() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Módulo `materials` (deshabilitado por defecto) y permisos
-- ---------------------------------------------------------------------------
-- Molde: 20261013130000_plans_entitlements.sql (una sola fuente de claves
-- para los 3 CHECK) y 20260929120000_reports_module_permission.sql (permisos,
-- sin backfill: el módulo nace apagado y el superadmin lo habilita por tenant).
create or replace function public.entitlement_module_keys() returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select array[
    'dashboard', 'conversations', 'channels', 'contacts', 'pipeline', 'products', 'sales', 'tasks',
    'calendar', 'campaigns', 'reports', 'automations', 'aiAgents', 'billing', 'integrations',
    'inventory', 'settings', 'credit', 'dispatches', 'returns', 'pos', 'expenses',
    'einvoicing', 'storefront', 'materials'
  ]::text[];
$$;

do $$
declare
  v_keys text[] := public.entitlement_module_keys();
begin
  execute 'alter table public.tenant_enabled_modules drop constraint if exists tenant_enabled_modules_module_key_check';
  execute format(
    'alter table public.tenant_enabled_modules add constraint tenant_enabled_modules_module_key_check check (module_key = any (%L::text[]))',
    v_keys
  );

  execute 'alter table public.billing_plan_modules drop constraint if exists billing_plan_modules_module_key_check';
  execute format(
    'alter table public.billing_plan_modules add constraint billing_plan_modules_module_key_check check (module_key = any (%L::text[]))',
    v_keys
  );

  execute 'alter table public.billing_subscription_modules drop constraint if exists billing_subscription_modules_module_key_check';
  execute format(
    'alter table public.billing_subscription_modules add constraint billing_subscription_modules_module_key_check check (module_key = any (%L::text[]))',
    v_keys
  );
end;
$$;

insert into public.permission_actions (key, module_key, name, description, display_order) values
  ('materials.view', 'materials', 'Ver insumos', 'Ver el listado de insumos, sus existencias y su kardex.', 1),
  ('materials.create', 'materials', 'Crear insumos', 'Crear un insumo nuevo.', 2),
  ('materials.edit', 'materials', 'Editar insumos', 'Editar los datos de un insumo.', 3),
  ('materials.delete', 'materials', 'Eliminar insumos', 'Eliminar (soft-delete) un insumo.', 4),
  ('materials.adjust_stock', 'materials', 'Ajustar existencias de insumos', 'Registrar cargas, compras y ajustes de existencias de insumos.', 5),
  ('products.manage_bom', 'products', 'Gestionar ficha técnica', 'Definir la ficha técnica (insumos y cantidades) de un producto y su modo de inventario.', 20);
