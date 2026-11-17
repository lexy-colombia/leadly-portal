-- F2 ronda 3 — Destino de UN SOLO USO en el carrito ("Usar en este pedido").
--
-- Un destino puntual (no guardado en la libreta del cliente) viaja como
-- `shipping_snapshot` jsonb con `shipping_address_id = null`: el carrito lo
-- guarda, create-order lo copia al pedido al INSERT, y el guard de confirmación
-- (20261112123000) lo respeta como destino propio. "Guardar también en el
-- cliente" sigue siendo crear la dirección en la libreta desde la UI.
--
-- save_cart_lines gana la clave `shipping_snapshot` del parche (ausente no toca;
-- null explícito la limpia). Copia literal de la versión de 20261112123000 +
-- esa línea; mismo revoke/grant que las demás.
alter table public.carts
  add column shipping_snapshot jsonb
    constraint carts_shipping_snapshot_object check (shipping_snapshot is null or jsonb_typeof(shipping_snapshot) = 'object');

create or replace function public.save_cart_lines(
  p_cart_id uuid,
  p_tenant_id uuid,
  p_patch jsonb,
  p_items jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
  v_items jsonb := coalesce(p_items, '[]'::jsonb);
  v_result jsonb;
begin
  if jsonb_typeof(v_items) <> 'array' then
    raise exception 'p_items debe ser un arreglo JSON.';
  end if;

  select c.status
    into v_status
    from public.carts c
   where c.id = p_cart_id
     and c.tenant_id = p_tenant_id
     for update;

  if not found then
    raise exception 'Carrito no encontrado.' using errcode = 'LX404';
  end if;
  if v_status <> 'open' then
    raise exception 'Este carrito ya no está abierto.' using errcode = 'LX409';
  end if;

  update public.carts c
     set contact_id = case when v_patch ? 'contact_id' then (v_patch ->> 'contact_id')::uuid else c.contact_id end,
         opportunity_id = case when v_patch ? 'opportunity_id' then (v_patch ->> 'opportunity_id')::uuid else c.opportunity_id end,
         notes = case when v_patch ? 'notes' then v_patch ->> 'notes' else c.notes end,
         valid_until = case when v_patch ? 'valid_until' then (v_patch ->> 'valid_until')::date else c.valid_until end,
         shipping_address_id = case when v_patch ? 'shipping_address_id' then (v_patch ->> 'shipping_address_id')::uuid else c.shipping_address_id end,
         billing_address_id = case when v_patch ? 'billing_address_id' then (v_patch ->> 'billing_address_id')::uuid else c.billing_address_id end,
         fulfillment_method = case when v_patch ? 'fulfillment_method' then v_patch ->> 'fulfillment_method' else c.fulfillment_method end,
         billing_profile_id = case when v_patch ? 'billing_profile_id' then (v_patch ->> 'billing_profile_id')::uuid else c.billing_profile_id end,
         shipping_snapshot = case when v_patch ? 'shipping_snapshot' then nullif(v_patch -> 'shipping_snapshot', 'null'::jsonb) else c.shipping_snapshot end,
         shipping = case when v_patch ? 'shipping' then (v_patch ->> 'shipping')::numeric else c.shipping end,
         pos_point_id = case when v_patch ? 'pos_point_id' then (v_patch ->> 'pos_point_id')::uuid else c.pos_point_id end,
         label = case when v_patch ? 'label' then v_patch ->> 'label' else c.label end,
         last_activity_at = now()
   where c.id = p_cart_id
     and c.tenant_id = p_tenant_id;

  perform set_config('lexy.skip_reservation_sync', 'on', true);

  delete from public.cart_items i where i.cart_id = p_cart_id;

  insert into public.cart_items (
    cart_id, product_id, variant_id, warehouse_id, product_name, sku,
    quantity, unit_price, discount_amount, created_at
  )
  select p_cart_id, x.product_id, x.variant_id, x.warehouse_id, x.product_name, x.sku,
         x.quantity, x.unit_price, coalesce(x.discount_amount, 0), clock_timestamp()
    from rows from (
           jsonb_to_recordset(v_items) as (
             product_id uuid, variant_id uuid, warehouse_id uuid, product_name text, sku text,
             quantity numeric, unit_price numeric, discount_amount numeric
           )
         ) with ordinality as x(
           product_id, variant_id, warehouse_id, product_name, sku,
           quantity, unit_price, discount_amount, ord
         )
   order by x.ord;

  perform set_config('lexy.skip_reservation_sync', 'off', true);

  -- Reserva atómica (LX422 si no alcanza -> rollback de todo lo anterior).
  perform public.sync_cart_reservations(p_cart_id);

  select to_jsonb(c) || jsonb_build_object(
           'items',
           coalesce(
             (select jsonb_agg(to_jsonb(i) order by i.created_at, i.id)
                from public.cart_items i
               where i.cart_id = c.id),
             '[]'::jsonb
           )
         )
    into v_result
    from public.carts c
   where c.id = p_cart_id;

  return v_result;
end;
$$;

comment on function public.save_cart_lines(uuid, uuid, jsonb, jsonb) is
  'Guarda de forma atómica la cabecera (solo claves presentes en p_patch), reemplaza las líneas de un carrito abierto y reserva el stock (LX422 si no alcanza). Solo service_role.';

comment on function public.save_cart_lines(uuid, uuid, jsonb, jsonb) is
  'Guarda de forma atómica la cabecera (solo claves presentes en p_patch, incl. shipping_snapshot), reemplaza las líneas de un carrito abierto y reserva el stock (LX422 si no alcanza). Solo service_role.';

revoke execute on function public.save_cart_lines(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_cart_lines(uuid, uuid, jsonb, jsonb) to service_role;
