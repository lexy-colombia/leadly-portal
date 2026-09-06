-- Módulo de Gastos, parte 2: "dar entrada de inventario" desde una línea de
-- un gasto (producto + bodega + cantidad + costo -> kardex + purchase_price
-- del producto/variante), con el tope de que la suma de líneas de un gasto
-- nunca puede superar expenses.amount -- pedido explícito del usuario.
--
-- expense_inventory_entries es append-only a propósito (solo policies de
-- select/insert, sin update/delete) -- mismo criterio que stock_movements:
-- una línea ya aplicada generó un movimiento de kardex inmutable y una
-- sobreescritura de purchase_price sin historial de versiones anteriores,
-- así que no hay una forma limpia de "editar" una línea después. Un error
-- se corrige con un ajuste manual de stock aparte (StockMovementDrawer ya
-- existente), no editando esta tabla.
create table public.expense_inventory_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  expense_id uuid not null references public.expenses(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  variant_id uuid references public.product_variants(id) on delete restrict,
  warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  quantity numeric not null check (quantity > 0),
  unit_cost numeric not null check (unit_cost >= 0),
  subtotal numeric not null check (subtotal >= 0),
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index expense_inventory_entries_tenant_id_idx on public.expense_inventory_entries(tenant_id);
create index expense_inventory_entries_expense_id_idx on public.expense_inventory_entries(expense_id);
create index expense_inventory_entries_product_id_idx on public.expense_inventory_entries(product_id);

alter table public.expense_inventory_entries enable row level security;

create policy expense_inventory_entries_select on public.expense_inventory_entries
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy expense_inventory_entries_insert on public.expense_inventory_entries
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.expense_inventory_entries from anon;

-- Envuelve en una sola transacción: validar el tope contra expenses.amount,
-- insertar la línea, insertar el movimiento de kardex (reference_type=
-- 'compra', ya es un valor válido del check constraint de stock_movements
-- desde 20260825013500 -- nadie lo usaba todavía) y sobreescribir
-- purchase_price (producto o variante, según corresponda). Mismo criterio
-- que transfer_stock() (20260817220000_transfer_stock_function.sql):
-- security invoker, cada insert pasa por su propia RLS como si el cliente
-- lo hubiera hecho directo, sin duplicar esa validación acá.
--
-- Los triggers ya existentes sobre stock_movements (validate_stock_movement
-- _variant, apply_stock_movement) se disparan solos con el insert de abajo
-- y mantienen product_stock al día -- no se reimplementa esa lógica acá.
--
-- Decisión explícita del usuario: purchase_price se SOBRESCRIBE con el
-- costo unitario de esta línea, sin ponderar contra compras anteriores.
-- wholesale_price/retail_price nunca se tocan.
create or replace function public.add_expense_inventory_entry(
  p_tenant_id uuid,
  p_expense_id uuid,
  p_product_id uuid,
  p_warehouse_id uuid,
  p_quantity numeric,
  p_unit_cost numeric,
  p_variant_id uuid default null,
  p_notes text default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_expense_amount numeric;
  v_expense_status text;
  v_current_total numeric;
  v_subtotal numeric;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'La cantidad debe ser mayor a cero';
  end if;
  if p_unit_cost is null or p_unit_cost < 0 then
    raise exception 'El costo unitario no puede ser negativo';
  end if;

  -- `for update` bloquea el header del gasto por el resto de esta
  -- transacción -- dos altas casi simultáneas sobre el mismo gasto no
  -- pueden leer ambas el mismo v_current_total y pasar el tope antes de
  -- que la primera confirme.
  select amount, status into v_expense_amount, v_expense_status
  from public.expenses
  where id = p_expense_id and tenant_id = p_tenant_id and deleted_at is null
  for update;

  if not found then
    raise exception 'Gasto inválido';
  end if;
  if v_expense_status = 'anulado' then
    raise exception 'No se pueden agregar entradas de inventario a un gasto anulado';
  end if;

  if not exists (select 1 from public.warehouses where id = p_warehouse_id and tenant_id = p_tenant_id) then
    raise exception 'Bodega inválida';
  end if;
  if not exists (select 1 from public.products where id = p_product_id and tenant_id = p_tenant_id and deleted_at is null) then
    raise exception 'Producto inválido';
  end if;
  if p_variant_id is not null and not exists (
    select 1 from public.product_variants where id = p_variant_id and product_id = p_product_id and tenant_id = p_tenant_id and deleted_at is null
  ) then
    raise exception 'Variante inválida';
  end if;

  v_subtotal := p_quantity * p_unit_cost;

  select coalesce(sum(subtotal), 0) into v_current_total
  from public.expense_inventory_entries
  where expense_id = p_expense_id;

  if v_current_total + v_subtotal > v_expense_amount then
    raise exception 'La suma de las entradas de inventario (%) superaría el monto del gasto (%)', v_current_total + v_subtotal, v_expense_amount;
  end if;

  insert into public.expense_inventory_entries
    (tenant_id, expense_id, product_id, variant_id, warehouse_id, quantity, unit_cost, subtotal, notes, created_by)
  values
    (p_tenant_id, p_expense_id, p_product_id, p_variant_id, p_warehouse_id, p_quantity, p_unit_cost, v_subtotal, p_notes, auth.uid())
  returning id into v_entry_id;

  insert into public.stock_movements
    (tenant_id, product_id, variant_id, warehouse_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by)
  values
    (p_tenant_id, p_product_id, p_variant_id, p_warehouse_id, 'entrada', p_quantity, p_unit_cost, 'compra', v_entry_id, p_notes, auth.uid());

  if p_variant_id is null then
    update public.products set purchase_price = p_unit_cost where id = p_product_id;
  else
    update public.product_variants set purchase_price = p_unit_cost where id = p_variant_id;
  end if;

  return v_entry_id;
end;
$$;

grant execute on function public.add_expense_inventory_entry(uuid, uuid, uuid, uuid, numeric, numeric, uuid, text) to authenticated;
