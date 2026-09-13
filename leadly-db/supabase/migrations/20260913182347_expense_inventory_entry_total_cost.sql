-- Entrada de inventario desde un gasto: se puede informar el COSTO TOTAL de
-- la línea en vez del costo unitario.
--
-- Motivo (pedido explícito del usuario, 2026-09-13): la factura del
-- proveedor trae el total por ítem, así que exigir el unitario obligaba a
-- dividir a mano antes de cargarlo. Ahora se manda uno de los dos y la
-- función calcula el otro; el cálculo vive acá y no en el navegador, igual
-- que el resto de los totales de la plataforma.
--
-- Con el total, `subtotal` es EXACTAMENTE la cifra de la factura: calcularlo
-- como cantidad × unitario redondeado desviaría centavos en cantidades que
-- no dividen exacto (3 unidades de $10.000 -> $3.333,33 c/u -> $9.999,99),
-- y ese subtotal es el que se compara contra el monto del gasto.
-- `unit_cost` (que también sobrescribe purchase_price) queda como el
-- cociente sin redondear, que es el costo real por unidad.
--
-- Se reemplaza la firma anterior (8 argumentos, p_unit_cost obligatorio) en
-- vez de agregar una sobrecarga: con argumentos nombrados dos versiones
-- serían ambiguas, y el único llamador es lib/api/expenses.ts.

drop function if exists public.add_expense_inventory_entry(uuid, uuid, uuid, uuid, numeric, numeric, uuid, text);

create or replace function public.add_expense_inventory_entry(
  p_tenant_id uuid,
  p_expense_id uuid,
  p_product_id uuid,
  p_warehouse_id uuid,
  p_quantity numeric,
  p_unit_cost numeric default null,
  p_total_cost numeric default null,
  p_variant_id uuid default null,
  p_notes text default null
)
returns uuid
language plpgsql
set search_path to 'public'
as $function$
declare
  v_entry_id uuid;
  v_expense_amount numeric;
  v_expense_status text;
  v_current_total numeric;
  v_subtotal numeric;
  v_unit_cost numeric;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'La cantidad debe ser mayor a cero';
  end if;
  if (p_unit_cost is null) = (p_total_cost is null) then
    raise exception 'Informá el costo total de la línea o el costo unitario, uno de los dos';
  end if;
  if p_unit_cost is not null and p_unit_cost < 0 then
    raise exception 'El costo unitario no puede ser negativo';
  end if;
  if p_total_cost is not null and p_total_cost < 0 then
    raise exception 'El costo total no puede ser negativo';
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

  if p_total_cost is not null then
    v_subtotal := p_total_cost;
    v_unit_cost := p_total_cost / p_quantity;
  else
    v_unit_cost := p_unit_cost;
    v_subtotal := p_quantity * p_unit_cost;
  end if;

  select coalesce(sum(subtotal), 0) into v_current_total
  from public.expense_inventory_entries
  where expense_id = p_expense_id;

  if v_current_total + v_subtotal > v_expense_amount then
    raise exception 'La suma de las entradas de inventario (%) superaría el monto del gasto (%)', v_current_total + v_subtotal, v_expense_amount;
  end if;

  insert into public.expense_inventory_entries
    (tenant_id, expense_id, product_id, variant_id, warehouse_id, quantity, unit_cost, subtotal, notes, created_by)
  values
    (p_tenant_id, p_expense_id, p_product_id, p_variant_id, p_warehouse_id, p_quantity, v_unit_cost, v_subtotal, p_notes, auth.uid())
  returning id into v_entry_id;

  insert into public.stock_movements
    (tenant_id, product_id, variant_id, warehouse_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by)
  values
    (p_tenant_id, p_product_id, p_variant_id, p_warehouse_id, 'entrada', p_quantity, v_unit_cost, 'compra', v_entry_id, p_notes, auth.uid());

  if p_variant_id is null then
    update public.products set purchase_price = v_unit_cost where id = p_product_id;
  else
    update public.product_variants set purchase_price = v_unit_cost where id = p_variant_id;
  end if;

  return v_entry_id;
end;
$function$;
