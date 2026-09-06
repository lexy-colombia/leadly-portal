-- Bug real reportado por el usuario (2026-09-06): en el POS, cargar un
-- producto al carrito no valida stock (correcto, es deliberado -- ver
-- comentario de PosFastCheckout.tsx), pero al "Cobrar" el trigger de
-- confirmación SÍ bloqueaba por stock insuficiente, dejando una
-- `sales_orders` huérfana en 'cotizacion' con el carrito intacto en
-- pantalla -- y como no había ninguna protección de idempotencia, cada
-- click repetido en "Cobrar" insertaba OTRA cotización huérfana más.
--
-- Razonamiento explícito del usuario: si un producto está siendo registrado
-- en el POS es porque el cliente YA lo tiene físicamente en sus manos -- no
-- tiene sentido bloquear esa venta por falta de stock (a diferencia de una
-- cotización, donde sí hace falta chequear antes de prometerle algo al
-- cliente). El stock sigue descontándose igual (vía
-- apply_sales_order_confirmed_stock_effect, que corre incondicionalmente al
-- confirmar) -- puede quedar negativo, y eso es intencional: refleja que se
-- vendió más de lo que el inventario registrado decía que había.
--
-- 1) El chequeo de stock de guard_sales_order_confirmation() se salta para
-- sales_channel='pos' -- mismo criterio y misma forma que el bloque de
-- direcciones que ya se salta para ese canal (20260904055616).
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
  if new.sales_channel is distinct from 'pos' then
    -- Chequeo de stock (variant-aware), solo para ítems de productos con
    -- track_inventory=true -- mismo criterio que confirmSalesOrder.ts. Una
    -- venta de mostrador (POS) se salta este chequeo a propósito: el
    -- producto ya está en manos del cliente, bloquear la venta acá no
    -- deshace eso, solo confunde al cajero.
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

-- 2) Idempotencia real para "Cobrar": sin esto, cada click que llega a
-- ejecutarse (incluso uno que falla por una razón que no sea stock, ej. un
-- error de red al registrar el pago) inserta una `sales_orders` nueva desde
-- cero -- pos-checkout y create-order van a resolver un intento repetido
-- contra la MISMA fila en vez de crear otra, usando este token que el
-- frontend genera una vez por intento de cobro y reenvía tal cual en cada
-- reintento.
alter table public.sales_orders add column if not exists checkout_token uuid;

create unique index if not exists sales_orders_tenant_checkout_token_key
  on public.sales_orders (tenant_id, checkout_token)
  where checkout_token is not null;
