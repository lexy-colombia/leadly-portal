-- R2 de "reserva de stock": disponibilidad unificada en el backend.
-- Se aplica JUNTO con 20261026120000_stock_reservations.sql (R1) y con las Edge
-- Functions de R2 (calculate-order, create-order, pos-checkout, storefront,
-- whatsapp-ai-tools). No toca apply_stock_movement ni los triggers de salida /
-- cancelacion de stock.
--
-- 1. DTO de disponibilidad para el frontend: dos RPC invocables por el
--    navegador (authenticated) que calculan `available` = fisico - reservado de
--    OTROS carritos con la funcion unica de R1. El tenant sale SIEMPRE de la
--    sesion (auth_active_tenant_id), nunca de un parametro.
-- 2. H3: guard_sales_order_confirmation (canales que no son POS: portal, tienda
--    publica, IA) compara contra disponible (fisico - reservas ajenas), con el
--    mismo lock por (tenant, producto, variante) que usa la reserva.
-- 3. H2: RPC que toma el lock del carrito ANTES de tocar cart_items, para que
--    create-order no se cruce con save_cart_lines (deadlock por orden de locks).

-- ---------------------------------------------------------------------------
-- 1. DTO `available`
-- ---------------------------------------------------------------------------
-- Una fila por (producto, variante, bodega) con stock o reservas. Solo
-- productos con track_inventory del tenant del llamador (un producto no
-- rastreado no aparece: el frontend lo trata como "sin limite"). Ausencia de
-- fila para un producto rastreado = disponible 0 en esa bodega.
-- Orden estable -> se puede paginar con .range() (PostgREST corta en 1000).
create or replace function public.get_stock_availability(
  p_product_ids uuid[] default null,
  p_exclude_cart_id uuid default null
)
returns table (
  product_id uuid,
  variant_id uuid,
  warehouse_id uuid,
  physical numeric,
  reserved numeric,
  available numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.product_id, r.variant_id, r.warehouse_id, r.physical, r.reserved, r.available
    from public.stock_availability_rows(public.auth_active_tenant_id(), p_product_ids, p_exclude_cart_id) r
    join public.products p
      on p.id = r.product_id
     and p.tenant_id = public.auth_active_tenant_id()
     and p.track_inventory = true
   order by r.product_id, r.variant_id nulls first, r.warehouse_id
$$;

comment on function public.get_stock_availability(uuid[], uuid) is
  'DTO de disponibilidad por producto/variante/bodega (fisico, reservado por OTROS carritos, disponible). Tenant desde la sesion. p_exclude_cart_id = la cuenta abierta propia.';

-- Totales (todas las bodegas): una fila 'product' por producto rastreado
-- (suma de todas sus variantes y bodegas; incluye productos sin filas de
-- stock con disponible 0) y una fila 'variant' por variante activa (variant_id
-- informado). Es EL numero que el frontend debe mostrar como "disponible".
create or replace function public.get_stock_availability_totals(
  p_product_ids uuid[] default null,
  p_exclude_cart_id uuid default null
)
returns table (
  product_id uuid,
  variant_id uuid,
  scope text,
  physical numeric,
  reserved numeric,
  available numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with tn as (select public.auth_active_tenant_id() as id),
  prods as (
    select p.id
      from public.products p, tn
     where p.tenant_id = tn.id
       and p.track_inventory = true
       and (p_product_ids is null or p.id = any (p_product_ids))
  ),
  rws as (
    select r.*
      from public.stock_availability_rows((select id from tn), p_product_ids, p_exclude_cart_id) r
      join prods on prods.id = r.product_id
  ),
  variant_keys as (
    select distinct w.product_id, w.variant_id from rws w where w.variant_id is not null
    union
    select v.product_id, v.id
      from public.product_variants v
      join prods on prods.id = v.product_id
     where v.tenant_id = (select id from tn) and v.is_active = true and v.deleted_at is null
  ),
  by_product as (
    select pr.id as product_id, coalesce(sum(w.physical), 0) as physical, coalesce(sum(w.reserved), 0) as reserved
      from prods pr
      left join rws w on w.product_id = pr.id
     group by pr.id
  ),
  by_variant as (
    select k.product_id, k.variant_id, coalesce(sum(w.physical), 0) as physical, coalesce(sum(w.reserved), 0) as reserved
      from variant_keys k
      left join rws w on w.product_id = k.product_id and w.variant_id = k.variant_id
     group by k.product_id, k.variant_id
  )
  select bp.product_id, null::uuid, 'product'::text, bp.physical, bp.reserved, greatest(bp.physical - bp.reserved, 0)
    from by_product bp
  union all
  select bv.product_id, bv.variant_id, 'variant'::text, bv.physical, bv.reserved, greatest(bv.physical - bv.reserved, 0)
    from by_variant bv
   order by 1, 2 nulls first, 3
$$;

comment on function public.get_stock_availability_totals(uuid[], uuid) is
  'DTO de disponibilidad total por producto (scope product) y por variante (scope variant). Tenant desde la sesion.';

revoke execute on function public.get_stock_availability(uuid[], uuid) from public, anon;
revoke execute on function public.get_stock_availability_totals(uuid[], uuid) from public, anon;
grant execute on function public.get_stock_availability(uuid[], uuid) to authenticated, service_role;
grant execute on function public.get_stock_availability_totals(uuid[], uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. H3: el guard de confirmacion mira disponible, no solo fisico
-- ---------------------------------------------------------------------------
-- Antes: fisico (product_stock) sin mirar reservas, asi que una venta de portal /
-- tienda / IA podia consumir lo que una mesa tenia reservado (y apply_stock_movement
-- recorta a 0 sin senal). Ahora: fisico - reservas vigentes de OTROS carritos
-- (se excluye el carrito del propio pedido: su reserva es la que esta por
-- consumirse). Toma el mismo lock por (tenant, producto, variante) que
-- sync_cart_reservations, en orden estable, para no cruzarse con una reserva
-- concurrente. Linea sin variante: se descuentan las reservas de cualquier
-- variante del producto (el fisico tambien suma todas, criterio de siempre).
-- El resto (direcciones, salto para canal 'pos') queda IDENTICO a 20260906120000.
create or replace function public.guard_sales_order_confirmation()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_item record;
  v_physical numeric;
  v_reserved numeric;
  v_available numeric;
  v_address_id uuid;
begin
  if new.sales_channel is distinct from 'pos' then
    for v_item in
      select soi.product_id, soi.variant_id, soi.product_name, soi.quantity
      from public.sales_order_items soi
      join public.products p on p.id = soi.product_id
      where soi.order_id = new.id and soi.product_id is not null and p.track_inventory = true
      order by soi.product_id, soi.variant_id nulls first
    loop
      perform pg_advisory_xact_lock(
        hashtextextended(new.tenant_id::text || ':' || v_item.product_id::text || ':' || coalesce(v_item.variant_id::text, ''), 0)
      );

      if v_item.variant_id is not null then
        select coalesce(sum(quantity), 0) into v_physical
        from public.product_stock
        where tenant_id = new.tenant_id and variant_id = v_item.variant_id;
      else
        select coalesce(sum(quantity), 0) into v_physical
        from public.product_stock
        where tenant_id = new.tenant_id and product_id = v_item.product_id;
      end if;

      select coalesce(sum(r.quantity), 0) into v_reserved
      from public.stock_reservations r
      where r.tenant_id = new.tenant_id
        and r.product_id = v_item.product_id
        and (v_item.variant_id is null or r.variant_id is not distinct from v_item.variant_id)
        and (r.expires_at is null or r.expires_at > now())
        and (new.cart_id is null or r.cart_id <> new.cart_id);

      v_available := v_physical - v_reserved;

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

-- ---------------------------------------------------------------------------
-- 3. H2: cobrar una cuenta sin cruzarse con save_cart_lines
-- ---------------------------------------------------------------------------
-- save_cart_lines toma el lock de la fila del carrito y luego borra filas de
-- cart_items; create-order borraba/actualizaba filas de cart_items y recien
-- despues el trigger pedia el lock del carrito: orden inverso -> deadlock si
-- dos dispositivos operan la misma cuenta a la vez. Esta funcion toma el lock
-- del carrito PRIMERO (mismo orden que save_cart_lines) y luego aplica lo
-- cobrado: borra las lineas cobradas completas y descuenta las parciales
-- (relativo, no absoluto: sobrevive a una edicion concurrente). Las lineas que
-- queden en <= 0 se eliminan.
create or replace function public.cart_settle_billed_items(
  p_cart_id uuid,
  p_tenant_id uuid,
  p_full_ids uuid[],
  p_partial jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform 1
    from public.carts c
   where c.id = p_cart_id and c.tenant_id = p_tenant_id
     for update;
  if not found then
    raise exception 'Carrito no encontrado.' using errcode = 'LX404';
  end if;

  if p_full_ids is not null and array_length(p_full_ids, 1) is not null then
    delete from public.cart_items i
     where i.cart_id = p_cart_id and i.id = any (p_full_ids);
  end if;

  if p_partial is not null and jsonb_typeof(p_partial) = 'array' and jsonb_array_length(p_partial) > 0 then
    -- Una línea que se cobra por completo (o más de lo que le queda, por una
    -- edición concurrente) se elimina; nunca queda en <= 0 (cart_items exige
    -- quantity > 0).
    delete from public.cart_items i
     using jsonb_to_recordset(p_partial) as x(id uuid, qty numeric)
     where i.id = x.id and i.cart_id = p_cart_id and i.quantity <= x.qty;
    update public.cart_items i
       set quantity = i.quantity - x.qty
      from jsonb_to_recordset(p_partial) as x(id uuid, qty numeric)
     where i.id = x.id and i.cart_id = p_cart_id and i.quantity > x.qty;
  end if;
end;
$$;

comment on function public.cart_settle_billed_items(uuid, uuid, uuid[], jsonb) is
  'Aplica al carrito lo ya cobrado (borra lineas completas, descuenta parciales) tomando antes el lock del carrito, mismo orden que save_cart_lines. Solo service_role.';

revoke execute on function public.cart_settle_billed_items(uuid, uuid, uuid[], jsonb) from public, anon, authenticated;
grant execute on function public.cart_settle_billed_items(uuid, uuid, uuid[], jsonb) to service_role;
