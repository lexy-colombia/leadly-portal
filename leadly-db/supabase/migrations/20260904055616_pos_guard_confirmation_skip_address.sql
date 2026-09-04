-- Único cambio quirúrgico para permitir confirmar una venta POS: el bloque
-- de direcciones (no el de stock, que sigue aplicando igual para cualquier
-- canal) se salta cuando sales_channel = 'pos' -- una venta de mostrador no
-- tiene envío, y su cliente (el de mostrador sembrado por
-- seed_default_walkin_client) no tiene ninguna dirección guardada.
create or replace function public.guard_sales_order_confirmation()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_item record;
  v_available numeric;
  v_address_id uuid;
begin
  -- Chequeo de stock (variant-aware), solo para ítems de productos con
  -- track_inventory=true -- mismo criterio que confirmSalesOrder.ts. Aplica
  -- SIEMPRE, sin importar el canal -- una venta POS tiene que descontar
  -- stock real igual que cualquier otra.
  for v_item in
    select soi.product_id, soi.variant_id, soi.product_name, soi.quantity
    from public.sales_order_items soi
    join public.products p on p.id = soi.product_id
    where soi.order_id = new.id and soi.product_id is not null and p.track_inventory = true
  loop
    if v_item.variant_id is not null then
      select coalesce(sum(quantity), 0) into v_available
      from public.product_stock
      where tenant_id = new.tenant_id and variant_id = v_item.variant_id;
    else
      select coalesce(sum(quantity), 0) into v_available
      from public.product_stock
      where tenant_id = new.tenant_id and product_id = v_item.product_id;
    end if;

    if v_available < v_item.quantity then
      raise exception 'INSUFFICIENT_STOCK: Stock insuficiente para confirmar "%": disponible %, pedido %.', v_item.product_name, greatest(0, v_available), v_item.quantity;
    end if;
  end loop;

  if new.sales_channel is distinct from 'pos' then
    -- Dirección de facturación: usa la que ya trae el pedido, si no busca la
    -- default del contacto (saltando texto placeholder), si no bloquea.
    if new.billing_address_id is null then
      select id into v_address_id
      from public.contact_addresses
      where tenant_id = new.tenant_id and contact_id = new.contact_id and is_billing = true and deleted_at is null
        and line1 is not null and line1 !~* 'no registrad|sin direcci[oó]n|pendiente|desconocid|por definir|n/a|\yna\y'
      order by is_default desc, created_at desc
      limit 1;
      if v_address_id is null then
        raise exception 'BILLING_ADDRESS_REQUIRED: El pedido no tiene dirección de facturación y el contacto no tiene ninguna guardada.';
      end if;
      new.billing_address_id := v_address_id;
    end if;

    -- Dirección de envío: mismo criterio.
    if new.shipping_address_id is null then
      select id into v_address_id
      from public.contact_addresses
      where tenant_id = new.tenant_id and contact_id = new.contact_id and is_shipping = true and deleted_at is null
        and line1 is not null and line1 !~* 'no registrad|sin direcci[oó]n|pendiente|desconocid|por definir|n/a|\yna\y'
      order by is_default desc, created_at desc
      limit 1;
      if v_address_id is null then
        raise exception 'SHIPPING_ADDRESS_REQUIRED: El pedido no tiene dirección de envío y el contacto no tiene ninguna guardada.';
      end if;
      new.shipping_address_id := v_address_id;
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_sales_order_confirmation() from public, anon, authenticated;
