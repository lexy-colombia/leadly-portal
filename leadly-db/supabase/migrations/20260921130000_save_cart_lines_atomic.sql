-- Guardado ATÓMICO de un carrito existente (cabecera + reemplazo de líneas).
--
-- Por qué: hasta ahora calculate-order hacía tres viajes separados desde la
-- Edge Function (update carts, delete cart_items, insert cart_items) sin
-- transacción. Dos guardados solapados del mismo carrito (autosave del POS +
-- un clic de "Cobrar") podían intercalarse: el segundo delete corría entre el
-- delete y el insert del primero y quedaban líneas duplicadas, o el carrito
-- quedaba vacío si un insert fallaba después del delete. Acá todo corre en UNA
-- transacción y el `for update` sobre la fila del carrito serializa los
-- guardados concurrentes del mismo carrito. Además baja de tres viajes
-- Edge -> PostgREST a uno solo.
--
-- Semántica de `p_patch` (misma que el cartPatch de la Edge Function): solo se
-- tocan las claves PRESENTES; una clave presente con valor null pone null, una
-- clave ausente no toca la columna. `last_activity_at` siempre se actualiza.
-- Claves permitidas: contact_id, opportunity_id, notes, valid_until,
-- shipping_address_id, billing_address_id, shipping, pos_point_id, label.
-- Cualquier otra clave se ignora (nada de SQL dinámico con la entrada).
--
-- Errores (SQLSTATE propio para que la Edge Function los traduzca):
--   LX404 -> el carrito no existe o no es de ese tenant
--   LX409 -> el carrito ya no está abierto
--
-- Solo la Edge Function con service role la llama (revoke a todos los demás);
-- el tenant llega ya resuelto por el servidor, nunca desde el navegador.
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

  -- Bloquea la fila: serializa guardados concurrentes del mismo carrito.
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
         shipping = case when v_patch ? 'shipping' then (v_patch ->> 'shipping')::numeric else c.shipping end,
         pos_point_id = case when v_patch ? 'pos_point_id' then (v_patch ->> 'pos_point_id')::uuid else c.pos_point_id end,
         label = case when v_patch ? 'label' then v_patch ->> 'label' else c.label end,
         last_activity_at = now()
   where c.id = p_cart_id
     and c.tenant_id = p_tenant_id;

  delete from public.cart_items i where i.cart_id = p_cart_id;

  -- created_at = clock_timestamp() (no now(), que es igual para toda la
  -- transacción) para que el orden de inserción quede reflejado y se pueda
  -- devolver las líneas en el mismo orden en que llegaron.
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
  'Guarda de forma atómica la cabecera (solo claves presentes en p_patch) y reemplaza las líneas de un carrito abierto. Solo service_role.';

revoke execute on function public.save_cart_lines(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_cart_lines(uuid, uuid, jsonb, jsonb) to service_role;
