-- Reserva de stock al cargar (disponible = físico - reservado), sin columna almacenada.
--
-- Origen: cuentas abiertas del POS. Se cargan productos, la mesa queda minutos
-- abierta, otras ventas consumen ese stock y al cobrar sale "no hay stock
-- suficiente". Ahora cargar una línea RESERVA; cobrar CONSUME la reserva.
--
-- Modelo:
--   * `stock_reservations`: una fila por (carrito, producto, variante, bodega)
--     con la cantidad reservada. Se mantiene SOLA a partir de `cart_items`
--     (triggers), así cubre TODOS los caminos que escriben líneas: la RPC
--     `save_cart_lines` (POS/portal) y las ediciones directas de la tienda
--     pública (add/update/remove/clear) y de `calculate-order` (carrito nuevo).
--   * Disponible = físico (`product_stock.quantity`) - reservas vigentes de
--     OTROS carritos. Una sola función (`stock_available`) y una variante por
--     filas (`stock_availability_rows`) para el DTO de producto (R2).
--   * Reserva atómica: `sync_cart_reservations` toma un lock transaccional por
--     (tenant, producto, variante) y compara contra el disponible. Sin disponible
--     -> error LX422 y la línea no se carga (la transacción se revierte).
--   * POS/mesas: sin vencimiento. Tienda pública (origin='storefront'): vence a
--     los 15 min, deslizante (cada edición renueva TODAS las reservas del
--     carrito). Al vencer la reserva se elimina pero el carrito y sus líneas se
--     conservan y se marca `carts.abandoned_at`. Un carrito 'portal' (borradores
--     de Órdenes) NO reserva: no promete stock (ver cart_reserves_stock).
--   * La salida física sigue en el trigger de confirmación (sin cambios). Al
--     confirmar una venta con cart_id la reserva se consume en la MISMA
--     transacción (por las cantidades del pedido, así el cobro parcial deja
--     reservado lo que queda en la cuenta). Cerrar/convertir/borrar el carrito
--     también la libera.
--
-- NO se reintroduce reserved_quantity (eliminada en agosto): la reserva vive en
-- su propia tabla y el disponible se calcula siempre.

-- ---------------------------------------------------------------------------
-- 1. Tabla
-- ---------------------------------------------------------------------------
create table public.stock_reservations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  cart_id uuid not null references public.carts(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  variant_id uuid references public.product_variants(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  quantity numeric not null check (quantity >= 0),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.stock_reservations is
  'Stock prometido por una cuenta/carrito abierto. Se mantiene por triggers desde cart_items; nunca se escribe desde el navegador. expires_at null = sin vencimiento (POS). Las filas con quantity 0 son transitorias (se borran en la misma función).';

create unique index stock_reservations_key_uidx
  on public.stock_reservations (cart_id, product_id, (coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)), warehouse_id);
create index stock_reservations_stock_idx
  on public.stock_reservations (tenant_id, product_id, warehouse_id);
create index stock_reservations_expiry_idx
  on public.stock_reservations (expires_at) where expires_at is not null;

create trigger stock_reservations_set_updated_at before update on public.stock_reservations
  for each row execute function public.set_updated_at();

-- RLS: el tenant solo LEE las suyas. Sin policies de insert/update/delete: solo
-- las funciones security definer (y service_role) las escriben. Es una tabla
-- operativa efímera (como cart_items), por eso se borra de verdad, sin soft-delete.
alter table public.stock_reservations enable row level security;
create policy stock_reservations_select on public.stock_reservations
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
revoke all on public.stock_reservations from anon;
revoke insert, update, delete, truncate on public.stock_reservations from authenticated;

-- Marca de abandono (tienda pública): el carrito y las líneas se conservan.
alter table public.carts add column abandoned_at timestamptz;
comment on column public.carts.abandoned_at is
  'Se marca cuando vence la reserva de un carrito de la tienda pública (15 min sin actividad). Se limpia al volver a reservar. Dato para métricas futuras de carritos abandonados.';

-- ---------------------------------------------------------------------------
-- 2. Qué carritos reservan
-- ---------------------------------------------------------------------------
create or replace function public.cart_reserves_stock(p_origin text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_origin in ('pos', 'storefront')
$$;

-- ---------------------------------------------------------------------------
-- 3. Disponibilidad (única fuente)
-- ---------------------------------------------------------------------------
-- Disponible = físico - reservas vigentes (expires_at null o futuro). Con
-- p_warehouse_id null se suman todas las bodegas del tenant (criterio de
-- findStockShortfalls para una línea sin bodega). p_exclude_cart_id deja fuera
-- las reservas del propio carrito. Nunca negativo.
create or replace function public.stock_available(
  p_tenant_id uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_warehouse_id uuid default null,
  p_exclude_cart_id uuid default null
)
returns numeric
language sql
stable
set search_path = ''
as $$
  select greatest(
    coalesce((
      select sum(ps.quantity)
        from public.product_stock ps
       where ps.tenant_id = p_tenant_id
         and ps.product_id = p_product_id
         and ps.variant_id is not distinct from p_variant_id
         and (p_warehouse_id is null or ps.warehouse_id = p_warehouse_id)
    ), 0)
    - coalesce((
      select sum(r.quantity)
        from public.stock_reservations r
       where r.tenant_id = p_tenant_id
         and r.product_id = p_product_id
         and r.variant_id is not distinct from p_variant_id
         and (p_warehouse_id is null or r.warehouse_id = p_warehouse_id)
         and (r.expires_at is null or r.expires_at > now())
         and (p_exclude_cart_id is null or r.cart_id <> p_exclude_cart_id)
    ), 0),
    0
  )
$$;

-- Misma cuenta por filas (producto, variante, bodega) para el DTO de producto.
create or replace function public.stock_availability_rows(
  p_tenant_id uuid,
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
set search_path = ''
as $$
  with phys as (
    select ps.product_id, ps.variant_id, ps.warehouse_id, sum(ps.quantity) as q
      from public.product_stock ps
     where ps.tenant_id = p_tenant_id
       and (p_product_ids is null or ps.product_id = any (p_product_ids))
     group by ps.product_id, ps.variant_id, ps.warehouse_id
  ), res as (
    select r.product_id, r.variant_id, r.warehouse_id, sum(r.quantity) as q
      from public.stock_reservations r
     where r.tenant_id = p_tenant_id
       and (p_product_ids is null or r.product_id = any (p_product_ids))
       and (r.expires_at is null or r.expires_at > now())
       and (p_exclude_cart_id is null or r.cart_id <> p_exclude_cart_id)
     group by r.product_id, r.variant_id, r.warehouse_id
  )
  select coalesce(p.product_id, s.product_id),
         coalesce(p.variant_id, s.variant_id),
         coalesce(p.warehouse_id, s.warehouse_id),
         coalesce(p.q, 0),
         coalesce(s.q, 0),
         greatest(coalesce(p.q, 0) - coalesce(s.q, 0), 0)
    from phys p
    full join res s
      on s.product_id = p.product_id
     and s.variant_id is not distinct from p.variant_id
     and s.warehouse_id = p.warehouse_id
$$;

-- ---------------------------------------------------------------------------
-- 4. Líneas deseadas de un carrito (helper interno)
-- ---------------------------------------------------------------------------
-- Una fila por (producto, variante, bodega de reserva). Solo productos del
-- tenant con track_inventory. Una línea sin bodega se reserva en la bodega por
-- defecto (la misma de la que sale el stock al confirmar) pero su chequeo es
-- contra el total de bodegas (check_all), igual que findStockShortfalls. Se
-- omiten: líneas sin producto, productos con variantes sin variante elegida
-- (nacen así desde el buscador; el chequeo viejo tampoco puede compararlas) y
-- líneas sin bodega cuando el tenant no tiene bodega por defecto.
create or replace function public.cart_desired_reservations(p_cart_id uuid, p_tenant_id uuid, p_default_wh uuid)
returns table (product_id uuid, variant_id uuid, warehouse_id uuid, check_all boolean, quantity numeric, product_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select i.product_id,
         i.variant_id,
         coalesce(i.warehouse_id, p_default_wh) as warehouse_id,
         bool_or(i.warehouse_id is null) as check_all,
         sum(i.quantity) as quantity,
         min(p.name) as product_name
    from public.cart_items i
    join public.products p
      on p.id = i.product_id
     and p.tenant_id = p_tenant_id
     and p.track_inventory = true
   where i.cart_id = p_cart_id
     and i.product_id is not null
     and (not p.has_variants or i.variant_id is not null)
     and coalesce(i.warehouse_id, p_default_wh) is not null
   group by i.product_id, i.variant_id, coalesce(i.warehouse_id, p_default_wh)
   order by i.product_id, i.variant_id nulls first, coalesce(i.warehouse_id, p_default_wh)
$$;

-- ---------------------------------------------------------------------------
-- 5. Reserva atómica: reconcilia las reservas de un carrito con sus líneas
-- ---------------------------------------------------------------------------
-- Errores: LX422 (stock insuficiente; DETAIL = arreglo JSON de faltantes
-- [{product_id, variant_id, warehouse_id, product_name, available, requested}]).
-- Solo se compara contra el disponible cuando la línea PIDE MÁS de lo que el
-- carrito ya tiene reservado y vigente: una cuenta que ya tenía su reserva no
-- se rechaza por un ajuste de stock posterior (se rechaza solo lo nuevo).
-- p_lenient (solo backfill): reserva lo que alcance en vez de fallar.
create or replace function public.sync_cart_reservations(p_cart_id uuid, p_lenient boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cart record;
  v_default_wh uuid;
  v_expires timestamptz;
  r record;
  v_existing numeric;
  v_avail numeric;
  v_qty numeric;
  v_shorts jsonb := '[]'::jsonb;
  v_msgs text[] := '{}';
  v_any boolean := false;
begin
  -- Serializa con save_cart_lines y con otras ediciones del mismo carrito.
  select c.id, c.tenant_id, c.origin, c.status
    into v_cart
    from public.carts c
   where c.id = p_cart_id
     for update;
  if not found then
    return; -- carrito borrado (cascada): las reservas ya cayeron por la FK
  end if;

  if v_cart.status <> 'open' or not public.cart_reserves_stock(v_cart.origin) then
    delete from public.stock_reservations where cart_id = p_cart_id;
    return;
  end if;

  select w.id into v_default_wh
    from public.warehouses w
   where w.tenant_id = v_cart.tenant_id and w.is_default and w.is_active and w.deleted_at is null
   limit 1;

  v_expires := case when v_cart.origin = 'storefront' then now() + interval '15 minutes' else null end;

  for r in select * from public.cart_desired_reservations(p_cart_id, v_cart.tenant_id, v_default_wh) loop
    v_any := true;
    -- Lock por (tenant, producto, variante): serializa a todos los que reservan
    -- ese producto (también una línea con bodega contra una sin bodega, que
    -- comparan contra el total). Orden estable (product, variant) = sin deadlock.
    perform pg_advisory_xact_lock(
      hashtextextended(v_cart.tenant_id::text || ':' || r.product_id::text || ':' || coalesce(r.variant_id::text, ''), 0)
    );

    select s.quantity into v_existing
      from public.stock_reservations s
     where s.cart_id = p_cart_id
       and s.product_id = r.product_id
       and s.variant_id is not distinct from r.variant_id
       and s.warehouse_id = r.warehouse_id
       and (s.expires_at is null or s.expires_at > now());
    v_existing := coalesce(v_existing, 0);

    v_qty := r.quantity;
    if r.quantity > v_existing then
      v_avail := public.stock_available(
        v_cart.tenant_id, r.product_id, r.variant_id,
        case when r.check_all then null else r.warehouse_id end,
        p_cart_id
      );
      if r.quantity > v_avail then
        if p_lenient then
          v_qty := greatest(least(r.quantity, v_avail), 0);
        else
          v_shorts := v_shorts || jsonb_build_object(
            'product_id', r.product_id, 'variant_id', r.variant_id, 'warehouse_id', r.warehouse_id,
            'product_name', r.product_name, 'available', v_avail, 'requested', r.quantity
          );
          v_msgs := v_msgs || format('"%s" (disponible %s, pedido %s)', r.product_name, v_avail, r.quantity);
          continue;
        end if;
      end if;
    end if;

    if v_qty > 0 then
      insert into public.stock_reservations (tenant_id, cart_id, product_id, variant_id, warehouse_id, quantity, expires_at)
      values (v_cart.tenant_id, p_cart_id, r.product_id, r.variant_id, r.warehouse_id, v_qty, v_expires)
      on conflict (cart_id, product_id, (coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)), warehouse_id)
      do update set quantity = excluded.quantity, expires_at = excluded.expires_at;
    end if;
  end loop;

  if jsonb_array_length(v_shorts) > 0 then
    raise exception 'Sin stock suficiente para: %.', array_to_string(v_msgs, ', ')
      using errcode = 'LX422', detail = v_shorts::text;
  end if;

  -- Reservas que ya no corresponden a ninguna línea (línea quitada o cantidad a 0).
  delete from public.stock_reservations s
   where s.cart_id = p_cart_id
     and not exists (
       select 1
         from public.cart_desired_reservations(p_cart_id, v_cart.tenant_id, v_default_wh) d
        where d.product_id = s.product_id
          and d.variant_id is not distinct from s.variant_id
          and d.warehouse_id = s.warehouse_id
     );

  -- Tienda pública: la actividad renueva TODAS las reservas (vencimiento
  -- deslizante; el upsert de arriba reescribe expires_at en cada línea) y, si
  -- vuelve a reservar, deja de estar "abandonado".
  if v_expires is not null and v_any then
    update public.carts set abandoned_at = null where id = p_cart_id and abandoned_at is not null;
  end if;
end;
$$;

comment on function public.sync_cart_reservations(uuid, boolean) is
  'Reconcilia stock_reservations con las líneas del carrito (reserva atómica con lock por producto). LX422 si no alcanza. Solo service_role / triggers.';

-- ---------------------------------------------------------------------------
-- 6. Triggers sobre cart_items (cubren todos los caminos de escritura)
-- ---------------------------------------------------------------------------
-- save_cart_lines borra e inserta todas las líneas: apaga el trigger con la
-- variable de sesión lexy.skip_reservation_sync y sincroniza UNA vez al final,
-- para no perder el estado "ya reservado" entre el delete y el insert.
create or replace function public.cart_items_sync_reservations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cart uuid;
begin
  if coalesce(current_setting('lexy.skip_reservation_sync', true), 'off') = 'on' then
    return null;
  end if;
  for v_cart in select distinct t.cart_id from changed_rows t order by 1 loop
    perform public.sync_cart_reservations(v_cart);
  end loop;
  return null;
end;
$$;

create trigger cart_items_reservations_ins after insert on public.cart_items
  referencing new table as changed_rows for each statement
  execute function public.cart_items_sync_reservations();
create trigger cart_items_reservations_upd after update on public.cart_items
  referencing new table as changed_rows for each statement
  execute function public.cart_items_sync_reservations();
create trigger cart_items_reservations_del after delete on public.cart_items
  referencing old table as changed_rows for each statement
  execute function public.cart_items_sync_reservations();

-- ---------------------------------------------------------------------------
-- 7. Liberación al cerrar/convertir el carrito
-- ---------------------------------------------------------------------------
create or replace function public.carts_release_reservations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.stock_reservations where cart_id = new.id;
  return new;
end;
$$;

create trigger carts_release_reservations_on_close after update of status on public.carts
  for each row
  when (old.status = 'open' and new.status <> 'open')
  execute function public.carts_release_reservations();

-- ---------------------------------------------------------------------------
-- 8. Consumo al confirmar la venta (misma transacción que la salida de kardex)
-- ---------------------------------------------------------------------------
-- Resta de la reserva del carrito las cantidades del pedido (mismas claves que
-- usa apply_sales_order_confirmed_stock_effect: bodega de la línea o la
-- predeterminada). Cobro parcial: lo no cobrado sigue reservado. Solo la
-- transición cotizacion -> confirmada (el trigger de salida es más laxo, pero
-- reconfirmar una cancelada no debe tocar reservas ajenas).
create or replace function public.consume_cart_reservation_on_confirm()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_default_wh uuid;
  v_row record;
begin
  select w.id into v_default_wh
    from public.warehouses w
   where w.tenant_id = new.tenant_id and w.is_default and w.is_active and w.deleted_at is null
   limit 1;

  for v_row in
    select soi.product_id, soi.variant_id, coalesce(soi.warehouse_id, v_default_wh) as warehouse_id, sum(soi.quantity) as quantity
      from public.sales_order_items soi
      join public.products p on p.id = soi.product_id and p.tenant_id = new.tenant_id
     where soi.order_id = new.id and soi.product_id is not null and p.track_inventory = true
     group by soi.product_id, soi.variant_id, coalesce(soi.warehouse_id, v_default_wh)
     order by 1, 2 nulls first, 3
  loop
    update public.stock_reservations s
       set quantity = greatest(s.quantity - v_row.quantity, 0)
     where s.cart_id = new.cart_id
       and s.tenant_id = new.tenant_id
       and s.product_id = v_row.product_id
       and s.variant_id is not distinct from v_row.variant_id
       and s.warehouse_id = v_row.warehouse_id;
  end loop;

  delete from public.stock_reservations s
   where s.cart_id = new.cart_id and s.tenant_id = new.tenant_id and s.quantity <= 0;
  return new;
end;
$$;

create trigger sales_orders_consume_cart_reservation after update of status on public.sales_orders
  for each row
  when (old.status = 'cotizacion' and new.status = 'confirmada' and new.cart_id is not null)
  execute function public.consume_cart_reservation_on_confirm();

-- ---------------------------------------------------------------------------
-- 9. Expiración de la tienda pública + marca de abandono
-- ---------------------------------------------------------------------------
-- La corrección NO depende del cron: stock_available ya ignora las reservas
-- vencidas. El job solo limpia filas y marca el abandono.
create or replace function public.expire_storefront_reservations()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_carts uuid[];
begin
  with gone as (
    delete from public.stock_reservations r
     where r.expires_at is not null and r.expires_at <= now()
     returning r.cart_id
  )
  select coalesce(array_agg(distinct cart_id), '{}') into v_carts from gone;

  update public.carts c
     set abandoned_at = now()
   where c.id = any (v_carts)
     and c.status = 'open'
     and c.origin = 'storefront'
     and c.abandoned_at is null;

  return coalesce(array_length(v_carts, 1), 0);
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. save_cart_lines: reserva dentro de la misma transacción
-- ---------------------------------------------------------------------------
-- Idéntica a la versión 20260921130000 salvo: apaga la sincronización por
-- trigger durante el reemplazo de líneas y sincroniza una sola vez al final.
-- Si no hay stock: LX422 (la transacción completa se revierte: la línea no se
-- carga y el carrito queda como estaba). El resto del contrato no cambia.
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

-- ---------------------------------------------------------------------------
-- 11. Privilegios
-- ---------------------------------------------------------------------------
revoke execute on function public.cart_reserves_stock(text) from public, anon, authenticated;
revoke execute on function public.stock_available(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.stock_availability_rows(uuid, uuid[], uuid) from public, anon, authenticated;
revoke execute on function public.cart_desired_reservations(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.sync_cart_reservations(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.cart_items_sync_reservations() from public, anon, authenticated;
revoke execute on function public.carts_release_reservations() from public, anon, authenticated;
revoke execute on function public.consume_cart_reservation_on_confirm() from public, anon, authenticated;
revoke execute on function public.expire_storefront_reservations() from public, anon, authenticated;
grant execute on function public.stock_available(uuid, uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.stock_availability_rows(uuid, uuid[], uuid) to service_role;
grant execute on function public.sync_cart_reservations(uuid, boolean) to service_role;
grant execute on function public.cart_reserves_stock(text) to service_role;
revoke execute on function public.save_cart_lines(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_cart_lines(uuid, uuid, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 12. Job de expiración (SQL puro, cada minuto)
-- ---------------------------------------------------------------------------
select cron.schedule(
  'expire_storefront_reservations',
  '* * * * *',
  $$select public.expire_storefront_reservations();$$
);

-- ---------------------------------------------------------------------------
-- 13. Backfill: cuentas POS abiertas (Barriles) reservan lo que hay hoy
-- ---------------------------------------------------------------------------
-- Modo indulgente: si el stock actual no alcanza para lo que ya tiene cargada
-- una cuenta, se reserva lo disponible (nunca se rompe la migración). Esa
-- cuenta seguirá rechazando ediciones que pidan más hasta que se quite la
-- línea sin stock, igual que ya hacía el POS (2026-09-20). Se procesan las
-- cuentas de más antigua a más nueva, así la más antigua conserva su stock.
do $$
declare
  v_cart record;
  v_n integer := 0;
begin
  for v_cart in
    select c.id from public.carts c
     where c.status = 'open' and c.origin = 'pos'
       and exists (select 1 from public.cart_items i where i.cart_id = c.id)
     order by c.created_at, c.id
  loop
    perform public.sync_cart_reservations(v_cart.id, true);
    v_n := v_n + 1;
  end loop;
  raise notice 'stock_reservations backfill: % cuentas POS abiertas procesadas', v_n;
end;
$$;
