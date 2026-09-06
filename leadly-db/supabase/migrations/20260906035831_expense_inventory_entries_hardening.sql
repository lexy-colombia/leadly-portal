-- Ajustes menores encontrados por get_advisors tras la migración anterior:
-- (1) variant_id/warehouse_id en expense_inventory_entries se consultan
-- igual que en stock_movements (que sí los indexa) -- se agregan los
-- índices que faltaban. (2) add_expense_inventory_entry tenía
-- search_path mutable (WARN de seguridad) -- se fija a 'public' explícito.
create index expense_inventory_entries_variant_id_idx on public.expense_inventory_entries(variant_id);
create index expense_inventory_entries_warehouse_id_idx on public.expense_inventory_entries(warehouse_id);

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
set search_path = public
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
