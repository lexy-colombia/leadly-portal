-- ERP pivot, Fase 2: Despachos. Pedido explícito del usuario 2026-08-23:
-- ícono junto a "Estado de envío" en la orden que abre un timeline tipo
-- courier, estados de despacho configurables por tenant (en el perfil de
-- la empresa, mismo lugar que Bodegas), operador logístico propio o
-- transportadora (catálogo fijo del lado del frontend, sin integración API
-- real por ahora -- solo un link de tracking calculado desde la guía), y
-- efecto real de inventario -- que hasta hoy `sales_orders`/
-- `sales_order_items` no tenían, ver 20260815010005_core_sales.sql.
--
-- Sorpresa al explorar el esquema: `stock_movements.movement_type` y
-- `product_stock` (reserved_quantity/departure_quantity/damaged_quantity)
-- YA tenían el ciclo de vida completo de un despacho modelado desde antes
-- ('reserva'/'liberacion_reserva'/'salida_despacho'/'entrega_despacho'/
-- 'ajuste_dano'/'reversion_dano', ver apply_stock_movement()), sin que
-- nada los disparara todavía. Esta migración no reinventa esa máquina de
-- estados -- la conecta.

-- =====================================================================
-- 1. dispatch_statuses -- catálogo de estados configurable por tenant
--    (mismo espíritu que pipeline_stages, pero una sola lista por tenant,
--    no varias "pipelines" de despacho). stock_effect marca en qué punto
--    del ciclo de vida real (reserve/ship/deliver) cae cada estado --
--    puede haber estados puramente informativos ('none', ej. "En camino")
--    entre dos que sí mueven inventario. maps_to_delivery_status
--    sincroniza el campo legado `sales_orders.delivery_status` (3 estados
--    fijos, usado por el badge/filtro de Órdenes) sin obligar a todos los
--    tenants a usar solo esos 3 nombres.
-- =====================================================================

create table public.dispatch_statuses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  color text not null default '#94A3B8',
  display_order integer not null default 0,
  stock_effect text not null default 'none' check (stock_effect in ('none', 'reserve', 'ship', 'deliver')),
  maps_to_delivery_status text check (maps_to_delivery_status in ('pendiente', 'en_camino', 'entregado')),
  is_terminal boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index dispatch_statuses_tenant_id_idx on public.dispatch_statuses(tenant_id);

create trigger dispatch_statuses_set_updated_at
  before update on public.dispatch_statuses
  for each row execute function public.set_updated_at();

alter table public.dispatch_statuses enable row level security;

create policy dispatch_statuses_select on public.dispatch_statuses
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy dispatch_statuses_insert on public.dispatch_statuses
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy dispatch_statuses_update on public.dispatch_statuses
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy dispatch_statuses_delete on public.dispatch_statuses
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.dispatch_statuses from anon;

-- =====================================================================
-- 2. dispatches -- un despacho por orden (1:1, sin envíos parciales en
--    esta ronda). carrier_type distingue reparto propio de transportadora;
--    carrier_key/tracking_number/tracking_url son del catálogo fijo del
--    frontend (lib/carriers.ts) -- no hay tabla de transportadoras, es
--    data de la app, no del tenant. stock_stage evita duplicar
--    movimientos de inventario si el estado avanza dos veces sobre el
--    mismo tramo (ver trigger de abajo).
-- =====================================================================

create table public.dispatches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  sales_order_id uuid not null unique references public.sales_orders(id) on delete cascade,
  status_id uuid not null references public.dispatch_statuses(id) on delete restrict,
  warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  carrier_type text not null check (carrier_type in ('propio', 'tercero')),
  carrier_key text,
  carrier_name text,
  tracking_number text,
  tracking_url text,
  stock_stage text not null default 'none' check (stock_stage in ('none', 'reserved', 'shipped', 'delivered')),
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index dispatches_tenant_id_idx on public.dispatches(tenant_id);
create index dispatches_status_id_idx on public.dispatches(status_id);
create index dispatches_warehouse_id_idx on public.dispatches(warehouse_id);

create trigger dispatches_set_updated_at
  before update on public.dispatches
  for each row execute function public.set_updated_at();

alter table public.dispatches enable row level security;

create policy dispatches_select on public.dispatches
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy dispatches_insert on public.dispatches
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy dispatches_update on public.dispatches
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.dispatches from anon;

-- =====================================================================
-- 3. dispatch_status_history -- append-only, es lo que alimenta el
--    timeline del modal ("Ver detalle"). Mismo patrón que
--    opportunity_stage_history: una fila al crear el despacho
--    (from_status_id null) y una por cada cambio de estado.
-- =====================================================================

create table public.dispatch_status_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  dispatch_id uuid not null references public.dispatches(id) on delete cascade,
  from_status_id uuid references public.dispatch_statuses(id) on delete set null,
  to_status_id uuid not null references public.dispatch_statuses(id) on delete restrict,
  changed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index dispatch_status_history_tenant_id_idx on public.dispatch_status_history(tenant_id);
create index dispatch_status_history_dispatch_id_idx on public.dispatch_status_history(dispatch_id);
create index dispatch_status_history_from_status_id_idx on public.dispatch_status_history(from_status_id);
create index dispatch_status_history_to_status_id_idx on public.dispatch_status_history(to_status_id);

alter table public.dispatch_status_history enable row level security;

create policy dispatch_status_history_select on public.dispatch_status_history
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy dispatch_status_history_insert on public.dispatch_status_history
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.dispatch_status_history from anon;

create or replace function public.log_dispatch_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.dispatch_status_history (tenant_id, dispatch_id, from_status_id, to_status_id, changed_by)
    values (new.tenant_id, new.id, null, new.status_id, new.created_by);
  elsif old.status_id is distinct from new.status_id then
    insert into public.dispatch_status_history (tenant_id, dispatch_id, from_status_id, to_status_id, changed_by)
    values (new.tenant_id, new.id, old.status_id, new.status_id, auth.uid());
  end if;
  return new;
end;
$$;

create trigger trg_dispatches_log_status_change
  after insert or update of status_id on public.dispatches
  for each row execute function public.log_dispatch_status_change();

-- =====================================================================
-- 4. Efecto de inventario: conecta el ciclo de vida del despacho con la
--    máquina de estados que ya existía en apply_stock_movement(). Corre
--    en BEFORE porque necesita mutar new.stock_stage. Encadena pasos
--    saltados (ej. Preparando -> Entregado directo sin pasar por
--    Despachado) para que el kardex quede consistente igual.
-- =====================================================================

create or replace function public.apply_dispatch_stock_and_delivery_effect()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_effect text;
  v_maps_to text;
  v_item record;
begin
  select stock_effect, maps_to_delivery_status into v_effect, v_maps_to
    from public.dispatch_statuses where id = new.status_id;

  if v_effect in ('reserve', 'ship', 'deliver') and new.stock_stage = 'none' then
    for v_item in
      select product_id, variant_id, warehouse_id, quantity
      from public.sales_order_items
      where order_id = new.sales_order_id and product_id is not null and warehouse_id is not null
    loop
      insert into public.stock_movements (tenant_id, product_id, variant_id, warehouse_id, movement_type, quantity, reference_type, reference_id, created_by)
      values (new.tenant_id, v_item.product_id, v_item.variant_id, v_item.warehouse_id, 'reserva', v_item.quantity, 'despacho', new.id, new.created_by);
    end loop;
    new.stock_stage := 'reserved';
  end if;

  if v_effect in ('ship', 'deliver') and new.stock_stage = 'reserved' then
    for v_item in
      select product_id, variant_id, warehouse_id, quantity
      from public.sales_order_items
      where order_id = new.sales_order_id and product_id is not null and warehouse_id is not null
    loop
      insert into public.stock_movements (tenant_id, product_id, variant_id, warehouse_id, movement_type, quantity, reference_type, reference_id, created_by)
      values (new.tenant_id, v_item.product_id, v_item.variant_id, v_item.warehouse_id, 'salida_despacho', v_item.quantity, 'despacho', new.id, new.created_by);
    end loop;
    new.stock_stage := 'shipped';
  end if;

  if v_effect = 'deliver' and new.stock_stage = 'shipped' then
    for v_item in
      select product_id, variant_id, warehouse_id, quantity
      from public.sales_order_items
      where order_id = new.sales_order_id and product_id is not null and warehouse_id is not null
    loop
      insert into public.stock_movements (tenant_id, product_id, variant_id, warehouse_id, movement_type, quantity, reference_type, reference_id, created_by)
      values (new.tenant_id, v_item.product_id, v_item.variant_id, v_item.warehouse_id, 'entrega_despacho', v_item.quantity, 'despacho', new.id, new.created_by);
    end loop;
    new.stock_stage := 'delivered';
  end if;

  if v_maps_to is not null then
    update public.sales_orders set delivery_status = v_maps_to where id = new.sales_order_id;
  end if;

  return new;
end;
$$;

create trigger trg_dispatches_stock_and_delivery_effect
  before insert or update of status_id on public.dispatches
  for each row execute function public.apply_dispatch_stock_and_delivery_effect();

-- =====================================================================
-- 5. Seed: 5 estados por defecto para tenants nuevos y backfill para los
--    existentes -- mismo patrón que seed_default_warehouse()/
--    seed_default_pipeline(). El tenant los puede renombrar/reordenar/
--    borrar después desde Configuración.
-- =====================================================================

create or replace function public.seed_default_dispatch_statuses()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.dispatch_statuses (tenant_id, name, color, display_order, stock_effect, maps_to_delivery_status, is_terminal) values
    (new.id, 'Preparando', '#F59E0B', 0, 'reserve', 'pendiente', false),
    (new.id, 'Despachado', '#3B82F6', 1, 'ship', 'en_camino', false),
    (new.id, 'En camino', '#6366F1', 2, 'none', 'en_camino', false),
    (new.id, 'Entregado', '#10B981', 3, 'deliver', 'entregado', true),
    (new.id, 'Devuelto', '#EF4444', 4, 'none', null, true);
  return new;
end;
$$;

create trigger tenants_seed_default_dispatch_statuses
  after insert on public.tenants
  for each row execute function public.seed_default_dispatch_statuses();

insert into public.dispatch_statuses (tenant_id, name, color, display_order, stock_effect, maps_to_delivery_status, is_terminal)
select t.id, v.name, v.color, v.display_order, v.stock_effect, v.maps_to_delivery_status, v.is_terminal
from public.tenants t
cross join (values
  ('Preparando', '#F59E0B', 0, 'reserve', 'pendiente', false),
  ('Despachado', '#3B82F6', 1, 'ship', 'en_camino', false),
  ('En camino', '#6366F1', 2, 'none', 'en_camino', false),
  ('Entregado', '#10B981', 3, 'deliver', 'entregado', true),
  ('Devuelto', '#EF4444', 4, 'none', null, true)
) as v(name, color, display_order, stock_effect, maps_to_delivery_status, is_terminal)
where not exists (select 1 from public.dispatch_statuses ds where ds.tenant_id = t.id);

-- =====================================================================
-- 6. Módulo togglable por tenant, mismo patrón que 'credit'/'inventory'.
--    hideFromNav en el frontend (vive dentro de Configuración + dentro de
--    la orden, no tiene ítem de nav propio -- mismo criterio que
--    'inventory'). Deshabilitado por defecto para todos los tenants.
-- =====================================================================

alter table public.tenant_enabled_modules drop constraint tenant_enabled_modules_module_key_check;
alter table public.tenant_enabled_modules add constraint tenant_enabled_modules_module_key_check check (module_key in (
  'dashboard', 'conversations', 'contacts', 'pipeline', 'products', 'sales',
  'tasks', 'calendar', 'campaigns', 'reports', 'automations', 'aiAgents',
  'billing', 'integrations', 'inventory', 'settings', 'credit', 'dispatches'
));
