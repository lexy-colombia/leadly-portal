-- Devoluciones/cambios, pedido explícito del usuario 2026-08-23: manejarlo
-- como MercadoLibre/Amazon puertas adentro -- el comprador ve pocas
-- opciones, pero cada vendedor (acá, cada tenant) configura su propia
-- política. Mismo mecanismo de catálogo-configurable-por-tenant que ya
-- usamos en dispatch_statuses, aplicado dos veces acá:
--
-- 1. return_statuses -- el ciclo de vida del ticket (Solicitada/Aprobada/
--    Recibida/Resuelta/Rechazada). A diferencia de dispatch_statuses, NO
--    lleva un efecto de inventario a nivel de estado -- una devolución
--    puede traer varios ítems con condiciones distintas en el mismo
--    ticket (uno vuelve bueno, otro dañado), así que el efecto de stock
--    se dispara por ítem (return_items.condition), no por el estado del
--    ticket completo.
-- 2. return_resolution_types -- cómo se resuelve en plata: el tenant le
--    pone el nombre que quiera, pero elige entre 4 efectos fijos
--    (saldo_a_favor/reembolso_efectivo/cambio/ninguno) que sí controlan
--    comportamiento real.
--
-- El motivo de la devolución (por qué el cliente la pide) NO es
-- configurable a propósito -- pedido explícito del usuario, se deja como
-- una constante fija (ver RETURN_REASONS en el frontend) en vez de un
-- tercer catálogo.

-- =====================================================================
-- 1. return_statuses -- catálogo configurable por tenant, sin efecto de
--    inventario (ver nota arriba).
-- =====================================================================

create table public.return_statuses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  color text not null default '#94A3B8',
  display_order integer not null default 0,
  is_terminal boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index return_statuses_tenant_id_idx on public.return_statuses(tenant_id);

create trigger return_statuses_set_updated_at
  before update on public.return_statuses
  for each row execute function public.set_updated_at();

alter table public.return_statuses enable row level security;

create policy return_statuses_select on public.return_statuses
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy return_statuses_insert on public.return_statuses
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy return_statuses_update on public.return_statuses
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy return_statuses_delete on public.return_statuses
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.return_statuses from anon;

-- =====================================================================
-- 2. return_resolution_types -- catálogo configurable por tenant, con un
--    efecto fijo de 4 posibles que sí dispara comportamiento real.
-- =====================================================================

create table public.return_resolution_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  effect text not null default 'ninguno' check (effect in ('saldo_a_favor', 'reembolso_efectivo', 'cambio', 'ninguno')),
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index return_resolution_types_tenant_id_idx on public.return_resolution_types(tenant_id);

create trigger return_resolution_types_set_updated_at
  before update on public.return_resolution_types
  for each row execute function public.set_updated_at();

alter table public.return_resolution_types enable row level security;

create policy return_resolution_types_select on public.return_resolution_types
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy return_resolution_types_insert on public.return_resolution_types
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy return_resolution_types_update on public.return_resolution_types
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy return_resolution_types_delete on public.return_resolution_types
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.return_resolution_types from anon;

-- =====================================================================
-- 3. returns -- el ticket. reason es una constante fija (no un catálogo),
--    ver RETURN_REASONS en lib/returnReasons.ts del frontend -- se
--    valida acá también con el mismo check, defensa en profundidad.
-- =====================================================================

create table public.returns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  sales_order_id uuid not null references public.sales_orders(id) on delete cascade,
  status_id uuid not null references public.return_statuses(id) on delete restrict,
  resolution_type_id uuid references public.return_resolution_types(id) on delete restrict,
  reason text not null check (reason in ('danado', 'equivocado', 'no_esperado', 'no_le_gusto', 'otro')),
  resolution_amount numeric(14, 2) check (resolution_amount >= 0),
  credit_granted boolean not null default false,
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index returns_tenant_id_idx on public.returns(tenant_id);
create index returns_sales_order_id_idx on public.returns(sales_order_id);
create index returns_status_id_idx on public.returns(status_id);
create index returns_resolution_type_id_idx on public.returns(resolution_type_id);

create trigger returns_set_updated_at
  before update on public.returns
  for each row execute function public.set_updated_at();

alter table public.returns enable row level security;

create policy returns_select on public.returns
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy returns_insert on public.returns
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy returns_update on public.returns
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.returns from anon;

-- =====================================================================
-- 4. return_items -- qué ítems (y cuánta cantidad) vuelven, y en qué
--    condición. El efecto de inventario se dispara por ítem cuando
--    condition pasa de 'pendiente' a 'bueno'/'danado' (trigger más abajo),
--    no por el estado general del ticket.
-- =====================================================================

create table public.return_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  return_id uuid not null references public.returns(id) on delete cascade,
  sales_order_item_id uuid not null references public.sales_order_items(id) on delete restrict,
  quantity numeric not null check (quantity > 0),
  condition text not null default 'pendiente' check (condition in ('pendiente', 'bueno', 'danado')),
  stock_applied boolean not null default false,
  created_at timestamptz not null default now()
);

create index return_items_tenant_id_idx on public.return_items(tenant_id);
create index return_items_return_id_idx on public.return_items(return_id);
create index return_items_sales_order_item_id_idx on public.return_items(sales_order_item_id);

alter table public.return_items enable row level security;

create policy return_items_select on public.return_items
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy return_items_insert on public.return_items
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy return_items_update on public.return_items
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.return_items from anon;

-- =====================================================================
-- 5. return_status_history -- timeline del ticket, append-only, mismo
--    patrón que dispatch_status_history.
-- =====================================================================

create table public.return_status_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  return_id uuid not null references public.returns(id) on delete cascade,
  from_status_id uuid references public.return_statuses(id) on delete set null,
  to_status_id uuid not null references public.return_statuses(id) on delete restrict,
  changed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index return_status_history_tenant_id_idx on public.return_status_history(tenant_id);
create index return_status_history_return_id_idx on public.return_status_history(return_id);
create index return_status_history_from_status_id_idx on public.return_status_history(from_status_id);
create index return_status_history_to_status_id_idx on public.return_status_history(to_status_id);

alter table public.return_status_history enable row level security;

create policy return_status_history_select on public.return_status_history
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy return_status_history_insert on public.return_status_history
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.return_status_history from anon;

create or replace function public.log_return_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.return_status_history (tenant_id, return_id, from_status_id, to_status_id, changed_by)
    values (new.tenant_id, new.id, null, new.status_id, new.created_by);
  elsif old.status_id is distinct from new.status_id then
    insert into public.return_status_history (tenant_id, return_id, from_status_id, to_status_id, changed_by)
    values (new.tenant_id, new.id, old.status_id, new.status_id, auth.uid());
  end if;
  return new;
end;
$$;

create trigger trg_returns_log_status_change
  after insert or update of status_id on public.returns
  for each row execute function public.log_return_status_change();

-- =====================================================================
-- 6. Kardex: dos movimientos nuevos, mismo mecanismo que ya conecta
--    Despachos (apply_stock_movement() no se toca, ya soporta cualquier
--    movement_type nuevo por el CHECK de abajo). 'bueno' repone stock
--    disponible; 'danado' entra directo a damaged_quantity, nunca pasa
--    por disponible -- nunca estuvo contado ahí desde que salió despachado.
-- =====================================================================

alter table public.stock_movements drop constraint stock_movements_movement_type_check;
alter table public.stock_movements add constraint stock_movements_movement_type_check check (movement_type in (
  'entrada', 'salida', 'ajuste_positivo', 'ajuste_negativo',
  'transferencia_salida', 'transferencia_entrada', 'reserva', 'liberacion_reserva',
  'salida_despacho', 'entrega_despacho', 'ajuste_dano', 'reversion_dano',
  'entrada_devolucion', 'devolucion_danada'
));

alter table public.stock_movements drop constraint stock_movements_reference_type_check;
alter table public.stock_movements add constraint stock_movements_reference_type_check check (reference_type in (
  'carga_inicial', 'compra', 'despacho', 'ajuste_manual', 'transferencia', 'devolucion'
));

create or replace function public.apply_stock_movement()
returns trigger
language plpgsql
as $$
declare
  v_available_delta numeric := 0;
  v_reserved_delta numeric := 0;
  v_departure_delta numeric := 0;
  v_damaged_delta numeric := 0;
begin
  case new.movement_type
    when 'entrada', 'ajuste_positivo', 'transferencia_entrada', 'entrada_devolucion' then
      v_available_delta := new.quantity;
    when 'salida', 'ajuste_negativo', 'transferencia_salida' then
      v_available_delta := -new.quantity;
    when 'reserva' then
      v_available_delta := -new.quantity;
      v_reserved_delta := new.quantity;
    when 'liberacion_reserva' then
      v_available_delta := new.quantity;
      v_reserved_delta := -new.quantity;
    when 'salida_despacho' then
      v_reserved_delta := -new.quantity;
      v_departure_delta := new.quantity;
    when 'entrega_despacho' then
      v_departure_delta := -new.quantity;
    when 'ajuste_dano', 'devolucion_danada' then
      v_damaged_delta := new.quantity;
      if new.movement_type = 'ajuste_dano' then
        v_available_delta := -new.quantity;
      end if;
    when 'reversion_dano' then
      v_available_delta := new.quantity;
      v_damaged_delta := -new.quantity;
  end case;

  if new.variant_id is null then
    insert into public.product_stock (tenant_id, product_id, warehouse_id, variant_id, quantity, reserved_quantity, departure_quantity, damaged_quantity)
    values (new.tenant_id, new.product_id, new.warehouse_id, null, greatest(0, v_available_delta), greatest(0, v_reserved_delta), greatest(0, v_departure_delta), greatest(0, v_damaged_delta))
    on conflict (product_id, warehouse_id) where variant_id is null
    do update set
      quantity = greatest(0, public.product_stock.quantity + v_available_delta),
      reserved_quantity = greatest(0, public.product_stock.reserved_quantity + v_reserved_delta),
      departure_quantity = greatest(0, public.product_stock.departure_quantity + v_departure_delta),
      damaged_quantity = greatest(0, public.product_stock.damaged_quantity + v_damaged_delta),
      updated_at = now();
  else
    insert into public.product_stock (tenant_id, product_id, warehouse_id, variant_id, quantity, reserved_quantity, departure_quantity, damaged_quantity)
    values (new.tenant_id, new.product_id, new.warehouse_id, new.variant_id, greatest(0, v_available_delta), greatest(0, v_reserved_delta), greatest(0, v_departure_delta), greatest(0, v_damaged_delta))
    on conflict (product_id, warehouse_id, variant_id) where variant_id is not null
    do update set
      quantity = greatest(0, public.product_stock.quantity + v_available_delta),
      reserved_quantity = greatest(0, public.product_stock.reserved_quantity + v_reserved_delta),
      departure_quantity = greatest(0, public.product_stock.departure_quantity + v_departure_delta),
      damaged_quantity = greatest(0, public.product_stock.damaged_quantity + v_damaged_delta),
      updated_at = now();
  end if;

  return new;
end;
$$;

-- Dispara el movimiento cuando un ítem pasa de 'pendiente' a 'bueno'/'danado'
-- -- una sola vez por ítem (stock_applied lo evita si alguien re-guarda el
-- mismo valor). product_id/warehouse_id/variant_id salen de
-- sales_order_items, igual que en Despachos.
create or replace function public.apply_return_item_stock_effect()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
  v_movement_type text;
begin
  if new.condition = 'pendiente' or new.stock_applied then
    return new;
  end if;

  select product_id, variant_id, warehouse_id into v_item
    from public.sales_order_items where id = new.sales_order_item_id;

  if v_item.product_id is null or v_item.warehouse_id is null then
    new.stock_applied := true;
    return new;
  end if;

  v_movement_type := case new.condition when 'bueno' then 'entrada_devolucion' else 'devolucion_danada' end;

  insert into public.stock_movements (tenant_id, product_id, variant_id, warehouse_id, movement_type, quantity, reference_type, reference_id, created_by)
  values (new.tenant_id, v_item.product_id, v_item.variant_id, v_item.warehouse_id, v_movement_type, new.quantity, 'devolucion', new.return_id, auth.uid());

  new.stock_applied := true;
  return new;
end;
$$;

create trigger trg_return_items_stock_effect
  before insert or update of condition on public.return_items
  for each row execute function public.apply_return_item_stock_effect();

-- =====================================================================
-- 7. store_credit_grants -- saldo a favor del cliente por una devolución
--    resuelta con effect='saldo_a_favor'. Ledger separado de
--    credit_charges/credit_payments a propósito -- "el cliente me debe"
--    (compra a crédito) y "yo le debo al cliente" (devolución) son
--    pasivos distintos, no el mismo balance con signo invertido.
--    Append-only (mismo patrón que credit_charges): nace del trigger de
--    abajo, nunca se edita a mano. Redimir ese saldo en una compra nueva
--    queda pendiente -- fase siguiente, no asumida acá.
-- =====================================================================

create table public.store_credit_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  return_id uuid not null unique references public.returns(id) on delete cascade,
  amount numeric(14, 2) not null check (amount > 0),
  created_at timestamptz not null default now()
);

create index store_credit_grants_tenant_id_idx on public.store_credit_grants(tenant_id);
create index store_credit_grants_client_id_idx on public.store_credit_grants(client_id);

alter table public.store_credit_grants enable row level security;

create policy store_credit_grants_select on public.store_credit_grants
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy store_credit_grants_insert on public.store_credit_grants
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.store_credit_grants from anon;

create or replace function public.apply_return_resolution_credit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_effect text;
  v_client_id uuid;
begin
  if new.resolution_type_id is null or new.resolution_amount is null or new.credit_granted then
    return new;
  end if;

  select effect into v_effect from public.return_resolution_types where id = new.resolution_type_id;
  if v_effect <> 'saldo_a_favor' then
    return new;
  end if;

  select contact_id into v_client_id from public.sales_orders where id = new.sales_order_id;

  insert into public.store_credit_grants (tenant_id, client_id, return_id, amount)
  values (new.tenant_id, v_client_id, new.id, new.resolution_amount);

  new.credit_granted := true;
  return new;
end;
$$;

create trigger trg_returns_resolution_credit
  before insert or update of resolution_type_id, resolution_amount on public.returns
  for each row execute function public.apply_return_resolution_credit();

-- =====================================================================
-- 8. Seed: estados y tipos de resolución por defecto para tenants nuevos
--    y backfill para los existentes -- mismo patrón que
--    seed_default_dispatch_statuses(). El tenant los puede renombrar/
--    reordenar/borrar después desde Configuración.
-- =====================================================================

create or replace function public.seed_default_return_catalogs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.return_statuses (tenant_id, name, color, display_order, is_terminal) values
    (new.id, 'Solicitada', '#F59E0B', 0, false),
    (new.id, 'Aprobada', '#3B82F6', 1, false),
    (new.id, 'Recibida', '#6366F1', 2, false),
    (new.id, 'Resuelta', '#10B981', 3, true),
    (new.id, 'Rechazada', '#EF4444', 4, true);

  insert into public.return_resolution_types (tenant_id, name, effect, display_order) values
    (new.id, 'Saldo a favor', 'saldo_a_favor', 0),
    (new.id, 'Reembolso en efectivo/transferencia', 'reembolso_efectivo', 1),
    (new.id, 'Cambio por otro producto', 'cambio', 2),
    (new.id, 'Sin resolución monetaria', 'ninguno', 3);

  return new;
end;
$$;

create trigger tenants_seed_default_return_catalogs
  after insert on public.tenants
  for each row execute function public.seed_default_return_catalogs();

insert into public.return_statuses (tenant_id, name, color, display_order, is_terminal)
select t.id, v.name, v.color, v.display_order, v.is_terminal
from public.tenants t
cross join (values
  ('Solicitada', '#F59E0B', 0, false),
  ('Aprobada', '#3B82F6', 1, false),
  ('Recibida', '#6366F1', 2, false),
  ('Resuelta', '#10B981', 3, true),
  ('Rechazada', '#EF4444', 4, true)
) as v(name, color, display_order, is_terminal)
where not exists (select 1 from public.return_statuses rs where rs.tenant_id = t.id);

insert into public.return_resolution_types (tenant_id, name, effect, display_order)
select t.id, v.name, v.effect, v.display_order
from public.tenants t
cross join (values
  ('Saldo a favor', 'saldo_a_favor', 0),
  ('Reembolso en efectivo/transferencia', 'reembolso_efectivo', 1),
  ('Cambio por otro producto', 'cambio', 2),
  ('Sin resolución monetaria', 'ninguno', 3)
) as v(name, effect, display_order)
where not exists (select 1 from public.return_resolution_types rrt where rrt.tenant_id = t.id);

-- =====================================================================
-- 9. Módulo togglable por tenant, mismo patrón que 'dispatches'/'credit'.
--    Con nav propio (a diferencia de Despachos/Inventario) -- Devoluciones
--    es una lista de tickets propia, no vive adentro de otra pantalla.
--    Deshabilitado por defecto para todos los tenants.
-- =====================================================================

alter table public.tenant_enabled_modules drop constraint tenant_enabled_modules_module_key_check;
alter table public.tenant_enabled_modules add constraint tenant_enabled_modules_module_key_check check (module_key in (
  'dashboard', 'conversations', 'contacts', 'pipeline', 'products', 'sales',
  'tasks', 'calendar', 'campaigns', 'reports', 'automations', 'aiAgents',
  'billing', 'integrations', 'inventory', 'settings', 'credit', 'dispatches', 'returns'
));
