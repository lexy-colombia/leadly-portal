-- Insumos + ficha técnica, PARTE 2: descuento al vender / reversión al anular,
-- reservas de insumos, disponibilidad derivada y RPC de listado.
-- Depende de 20261027120000 (esquema) y de las reservas 20261026120000/130000.
--
-- Decisiones (ver también progress/A_backend_report.md):
--   * Descuento y reversión en triggers HERMANOS de los de producto
--     (apply_sales_order_confirmed_materials_effect / ..._cancelled_...): los
--     triggers de productos 'stock' NO cambian, salvo UNA línea imprescindible
--     en apply_sales_order_confirmed_stock_effect (no emitir salida de producto
--     para un producto 'recipe', que no tiene stock propio).
--   * Reservas de insumos en TABLA PROPIA `material_reservations` (por carrito e
--     insumo, sin bodega: el disponible de un insumo es el total de sus
--     bodegas). stock_reservations no se toca. Misma regla: POS sin
--     vencimiento, tienda 15 min deslizante, LX422 si no alcanza.
--   * Disponible de un producto 'recipe' = min sobre su ficha de
--     floor(disponible del insumo / cantidad por unidad); sin ficha o con un
--     insumo inactivo/borrado = 0. Sale por stock_availability_rows (fila
--     única, variant_id y warehouse_id null) para que get_stock_availability*,
--     la tienda y la IA lo lean sin cambios.
--   * Un insumo se descuenta de la bodega de la línea o de la bodega por
--     defecto (igual que los productos) y el disponible/chequeo es sobre el
--     TOTAL de bodegas (igual que findStockShortfalls para una línea sin bodega).

-- ---------------------------------------------------------------------------
-- 1. Reservas de insumos
-- ---------------------------------------------------------------------------
create table public.material_reservations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  cart_id uuid not null references public.carts(id) on delete cascade,
  material_id uuid not null references public.materials(id) on delete cascade,
  quantity numeric(14,4) not null check (quantity >= 0),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cart_id, material_id)
);

comment on table public.material_reservations is
  'Insumos prometidos por una cuenta/carrito abierto con productos recipe. Se mantiene por sync_cart_reservations; nunca se escribe desde el navegador. expires_at null = sin vencimiento (POS).';

create index material_reservations_stock_idx on public.material_reservations (tenant_id, material_id);
create index material_reservations_expiry_idx on public.material_reservations (expires_at) where expires_at is not null;

create trigger material_reservations_set_updated_at before update on public.material_reservations
  for each row execute function public.set_updated_at();

alter table public.material_reservations enable row level security;
create policy material_reservations_select on public.material_reservations
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
revoke all on public.material_reservations from anon;
revoke insert, update, delete, truncate on public.material_reservations from authenticated;

-- ---------------------------------------------------------------------------
-- 2. Disponibilidad y demanda de insumos (helpers; solo service_role)
-- ---------------------------------------------------------------------------
-- Disponible de un insumo = existencias (todas las bodegas) - reservas vigentes
-- de OTROS carritos. 0 si el insumo está inactivo, borrado o es de otro tenant.
create or replace function public.material_available(
  p_tenant_id uuid,
  p_material_id uuid,
  p_exclude_cart_id uuid default null
)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (
      select 1 from public.materials m
       where m.id = p_material_id and m.tenant_id = p_tenant_id and m.is_active and m.deleted_at is null
    )
    then greatest(
      coalesce((
        select sum(ms.quantity) from public.material_stock ms
         where ms.tenant_id = p_tenant_id and ms.material_id = p_material_id
      ), 0)
      - coalesce((
        select sum(r.quantity) from public.material_reservations r
         where r.tenant_id = p_tenant_id and r.material_id = p_material_id
           and (r.expires_at is null or r.expires_at > now())
           and (p_exclude_cart_id is null or r.cart_id <> p_exclude_cart_id)
      ), 0),
      0)
    else 0
  end
$$;

-- Qué insumos consumen unas líneas [{product_id, quantity}] (solo productos
-- 'recipe' del tenant con ficha): una fila por (producto, insumo) con la
-- cantidad necesaria. Las líneas del mismo producto se suman.
create or replace function public.recipe_demand_lines(p_tenant_id uuid, p_items jsonb)
returns table (product_id uuid, product_name text, product_qty numeric, material_id uuid, per_unit numeric, need numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with lines as (
    select (x ->> 'product_id')::uuid as pid, sum((x ->> 'quantity')::numeric) as qty
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
     where x ->> 'product_id' is not null and coalesce((x ->> 'quantity')::numeric, 0) > 0
     group by 1
  )
  select p.id, p.name, l.qty, b.material_id, b.quantity, l.qty * b.quantity
    from lines l
    join public.products p on p.id = l.pid and p.tenant_id = p_tenant_id and p.inventory_mode = 'recipe'
    join public.product_bom b on b.product_id = p.id and b.tenant_id = p_tenant_id
   order by p.id, b.material_id
$$;

-- Faltantes de insumos para unas líneas. Una fila por (producto recipe, insumo
-- corto) con `available_units` = unidades de ESE producto que alcanzan con el
-- insumo, y una fila (material_id null) por cada producto recipe SIN ficha.
-- El consumo se suma ENTRE líneas/productos (insumos compartidos) antes de
-- comparar. p_exclude_cart_id deja fuera las reservas del carrito propio.
create or replace function public.recipe_shortfalls(p_tenant_id uuid, p_items jsonb, p_exclude_cart_id uuid default null)
returns table (
  product_id uuid,
  product_name text,
  material_id uuid,
  material_name text,
  unit text,
  available_units numeric,
  requested numeric,
  material_available numeric,
  material_required numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with dem as (select * from public.recipe_demand_lines(p_tenant_id, p_items)),
  tot as (
    select d.material_id, sum(d.need) as required from dem d group by d.material_id
  ),
  mav as (
    select t.material_id, t.required,
           public.material_available(p_tenant_id, t.material_id, p_exclude_cart_id) as avail,
           m.name, m.unit
      from tot t
      left join public.materials m on m.id = t.material_id and m.tenant_id = p_tenant_id
  )
  select d.product_id, d.product_name, mav.material_id, mav.name, mav.unit,
         floor(mav.avail / d.per_unit), d.product_qty, mav.avail, mav.required
    from dem d
    join mav on mav.material_id = d.material_id
   where mav.required > mav.avail
  union all
  select p.id, p.name, null::uuid, null::text, null::text, 0::numeric, l.qty, 0::numeric, l.qty
    from (
      select (x ->> 'product_id')::uuid as pid, sum((x ->> 'quantity')::numeric) as qty
        from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
       where x ->> 'product_id' is not null and coalesce((x ->> 'quantity')::numeric, 0) > 0
       group by 1
    ) l
    join public.products p on p.id = l.pid and p.tenant_id = p_tenant_id and p.inventory_mode = 'recipe'
   where not exists (select 1 from public.product_bom b where b.product_id = p.id and b.tenant_id = p_tenant_id)
$$;

-- Disponibilidad derivada de los productos 'recipe' (misma forma que
-- stock_availability_rows). Una fila por producto, variant_id y warehouse_id
-- null: physical = unidades que alcanzarían con TODO el stock de insumos,
-- available = con el disponible (sin reservas de otros carritos).
create or replace function public.recipe_availability_rows(
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
security definer
set search_path = ''
as $$
  with per_product as (
    select p.id as product_id,
           count(b.id) as n,
           min(case when m.ok then floor(m.phys / b.quantity) else 0 end) as u_phys,
           min(case when m.ok then floor(greatest(m.phys - m.res, 0) / b.quantity) else 0 end) as u_avail
      from public.products p
      left join public.product_bom b on b.product_id = p.id and b.tenant_id = p_tenant_id
      left join lateral (
        select (mt.is_active and mt.deleted_at is null) as ok,
               coalesce((select sum(ms.quantity) from public.material_stock ms
                          where ms.tenant_id = p_tenant_id and ms.material_id = mt.id), 0) as phys,
               coalesce((select sum(r.quantity) from public.material_reservations r
                          where r.tenant_id = p_tenant_id and r.material_id = mt.id
                            and (r.expires_at is null or r.expires_at > now())
                            and (p_exclude_cart_id is null or r.cart_id <> p_exclude_cart_id)), 0) as res
          from public.materials mt
         where mt.id = b.material_id and mt.tenant_id = p_tenant_id
      ) m on true
     where p.tenant_id = p_tenant_id
       and p.inventory_mode = 'recipe'
       and (p_product_ids is null or p.id = any (p_product_ids))
     group by p.id
  )
  select pp.product_id, null::uuid, null::uuid,
         case when pp.n = 0 then 0 else coalesce(pp.u_phys, 0) end,
         case when pp.n = 0 then 0 else greatest(coalesce(pp.u_phys, 0) - coalesce(pp.u_avail, 0), 0) end,
         case when pp.n = 0 then 0 else coalesce(pp.u_avail, 0) end
    from per_product pp
$$;

-- ---------------------------------------------------------------------------
-- 3. stock_availability_rows: productos 'stock' como siempre + 'recipe' derivado
-- ---------------------------------------------------------------------------
-- Cambio mínimo sobre 20261026120000: el stock propio solo cuenta para
-- productos 'stock' (un producto pasado a 'recipe' conserva filas viejas de
-- product_stock que NO deben mostrarse) y se agregan las filas de recipe.
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
      join public.products pp on pp.id = ps.product_id and pp.tenant_id = p_tenant_id and pp.inventory_mode = 'stock'
     where ps.tenant_id = p_tenant_id
       and (p_product_ids is null or ps.product_id = any (p_product_ids))
     group by ps.product_id, ps.variant_id, ps.warehouse_id
  ), res as (
    select r.product_id, r.variant_id, r.warehouse_id, sum(r.quantity) as q
      from public.stock_reservations r
      join public.products pp on pp.id = r.product_id and pp.tenant_id = p_tenant_id and pp.inventory_mode = 'stock'
     where r.tenant_id = p_tenant_id
       and (p_product_ids is null or r.product_id = any (p_product_ids))
       and (r.expires_at is null or r.expires_at > now())
       and (p_exclude_cart_id is null or r.cart_id <> p_exclude_cart_id)
     group by r.product_id, r.variant_id, r.warehouse_id
  ), stock_rows as (
    select coalesce(p.product_id, s.product_id) as product_id,
           coalesce(p.variant_id, s.variant_id) as variant_id,
           coalesce(p.warehouse_id, s.warehouse_id) as warehouse_id,
           coalesce(p.q, 0) as physical,
           coalesce(s.q, 0) as reserved,
           greatest(coalesce(p.q, 0) - coalesce(s.q, 0), 0) as available
      from phys p
      full join res s
        on s.product_id = p.product_id
       and s.variant_id is not distinct from p.variant_id
       and s.warehouse_id = p.warehouse_id
  )
  select sr.product_id, sr.variant_id, sr.warehouse_id, sr.physical, sr.reserved, sr.available from stock_rows sr
  union all
  select rr.product_id, rr.variant_id, rr.warehouse_id, rr.physical, rr.reserved, rr.available
    from public.recipe_availability_rows(p_tenant_id, p_product_ids, p_exclude_cart_id) rr
$$;

-- ---------------------------------------------------------------------------
-- 4. Reservas del carrito: productos 'stock' como siempre + insumos
-- ---------------------------------------------------------------------------
-- 4a. Las líneas de productos 'recipe' no reservan stock propio.
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
     and p.inventory_mode = 'stock'
   where i.cart_id = p_cart_id
     and i.product_id is not null
     and (not p.has_variants or i.variant_id is not null)
     and coalesce(i.warehouse_id, p_default_wh) is not null
   group by i.product_id, i.variant_id, coalesce(i.warehouse_id, p_default_wh)
   order by i.product_id, i.variant_id nulls first, coalesce(i.warehouse_id, p_default_wh)
$$;

-- 4b. Reserva atómica de los insumos de un carrito. Devuelve true si el carrito
-- tiene alguna línea recipe. Errores: LX422 con DETAIL = arreglo JSON de
-- faltantes con la forma de los de producto (product_id = el producto recipe,
-- available = unidades de ese producto que alcanzan, requested = unidades
-- pedidas) más material_id/material_name/unit. Solo se compara contra el
-- disponible cuando el carrito pide MÁS de lo que ya tiene reservado y
-- vigente (igual que los productos). p_lenient = solo backfill.
create or replace function public.sync_cart_material_reservations(
  p_cart_id uuid,
  p_tenant_id uuid,
  p_expires timestamptz,
  p_lenient boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
  r record;
  s record;
  v_existing numeric;
  v_avail numeric;
  v_qty numeric;
  v_short_mats uuid[] := '{}';
  v_shorts jsonb := '[]'::jsonb;
  v_msgs text[] := '{}';
  v_any boolean := false;
begin
  select coalesce(jsonb_agg(jsonb_build_object('product_id', i.product_id, 'quantity', i.quantity)), '[]'::jsonb)
    into v_items
    from public.cart_items i
   where i.cart_id = p_cart_id and i.product_id is not null;

  for r in
    select d.material_id, sum(d.need) as required
      from public.recipe_demand_lines(p_tenant_id, v_items) d
     group by d.material_id
     order by d.material_id
  loop
    v_any := true;
    -- Mismo esquema de lock que los productos (clave distinta). Los productos
    -- se bloquean ANTES (en sync_cart_reservations) y los insumos después, en
    -- orden de material_id: orden global estable = sin deadlock.
    perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':m:' || r.material_id::text, 0));

    select mr.quantity into v_existing
      from public.material_reservations mr
     where mr.cart_id = p_cart_id and mr.material_id = r.material_id
       and (mr.expires_at is null or mr.expires_at > now());
    v_existing := coalesce(v_existing, 0);

    v_qty := r.required;
    if r.required > v_existing then
      v_avail := public.material_available(p_tenant_id, r.material_id, p_cart_id);
      if r.required > v_avail then
        if p_lenient then
          v_qty := greatest(least(r.required, v_avail), 0);
        else
          v_short_mats := v_short_mats || r.material_id;
          continue;
        end if;
      end if;
    end if;

    if v_qty > 0 then
      insert into public.material_reservations (tenant_id, cart_id, material_id, quantity, expires_at)
      values (p_tenant_id, p_cart_id, r.material_id, v_qty, p_expires)
      on conflict (cart_id, material_id)
      do update set quantity = excluded.quantity, expires_at = excluded.expires_at;
    end if;
  end loop;

  if array_length(v_short_mats, 1) is not null then
    for s in
      select d.product_id, d.product_name, d.product_qty, d.per_unit, d.material_id,
             m.name as material_name, m.unit,
             public.material_available(p_tenant_id, d.material_id, p_cart_id) as avail
        from public.recipe_demand_lines(p_tenant_id, v_items) d
        join public.materials m on m.id = d.material_id and m.tenant_id = p_tenant_id
       where d.material_id = any (v_short_mats)
       order by d.product_id, d.material_id
    loop
      v_shorts := v_shorts || jsonb_build_object(
        'product_id', s.product_id, 'variant_id', null, 'warehouse_id', null,
        'product_name', s.product_name, 'available', floor(s.avail / s.per_unit), 'requested', s.product_qty,
        'material_id', s.material_id, 'material_name', s.material_name, 'unit', s.unit
      );
      v_msgs := v_msgs || format('"%s" (insumo "%s": disponible %s %s)', s.product_name, s.material_name, s.avail, s.unit);
    end loop;
  end if;

  -- Producto recipe sin ficha técnica: no se puede vender (disponible 0).
  if not p_lenient then
    for s in
      select p.id as product_id, p.name as product_name, sum(i.quantity) as qty
        from public.cart_items i
        join public.products p on p.id = i.product_id and p.tenant_id = p_tenant_id and p.inventory_mode = 'recipe'
       where i.cart_id = p_cart_id
         and not exists (select 1 from public.product_bom b where b.product_id = p.id and b.tenant_id = p_tenant_id)
       group by p.id, p.name
       order by p.id
    loop
      v_shorts := v_shorts || jsonb_build_object(
        'product_id', s.product_id, 'variant_id', null, 'warehouse_id', null,
        'product_name', s.product_name, 'available', 0, 'requested', s.qty,
        'material_id', null, 'material_name', null, 'unit', null
      );
      v_msgs := v_msgs || format('"%s" (sin ficha técnica)', s.product_name);
    end loop;
  end if;

  if jsonb_array_length(v_shorts) > 0 then
    raise exception 'Sin stock suficiente para: %.', array_to_string(v_msgs, ', ')
      using errcode = 'LX422', detail = v_shorts::text;
  end if;

  -- Reservas de insumos que ya no corresponden a ninguna línea.
  delete from public.material_reservations mr
   where mr.cart_id = p_cart_id
     and not exists (
       select 1 from public.recipe_demand_lines(p_tenant_id, v_items) d where d.material_id = mr.material_id
     );

  return v_any;
end;
$$;

-- 4c. sync_cart_reservations: idéntica a la de 20261026120000 salvo (1) también
-- libera/crea reservas de insumos y (2) la marca de abandono considera líneas
-- recipe.
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
    delete from public.material_reservations where cart_id = p_cart_id;
    return;
  end if;

  select w.id into v_default_wh
    from public.warehouses w
   where w.tenant_id = v_cart.tenant_id and w.is_default and w.is_active and w.deleted_at is null
   limit 1;

  v_expires := case when v_cart.origin = 'storefront' then now() + interval '15 minutes' else null end;

  for r in select * from public.cart_desired_reservations(p_cart_id, v_cart.tenant_id, v_default_wh) loop
    v_any := true;
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

  -- Insumos de las líneas recipe (LX422 propio si no alcanzan).
  if public.sync_cart_material_reservations(v_cart.id, v_cart.tenant_id, v_expires, p_lenient) then
    v_any := true;
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

  if v_expires is not null and v_any then
    update public.carts set abandoned_at = null where id = p_cart_id and abandoned_at is not null;
  end if;
end;
$$;

-- 4d. Liberación al cerrar/convertir el carrito.
create or replace function public.carts_release_reservations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.stock_reservations where cart_id = new.id;
  delete from public.material_reservations where cart_id = new.id;
  return new;
end;
$$;

-- 4e. Consumo al confirmar: además de las reservas de producto, resta las de
-- insumos por las cantidades del pedido (cobro parcial deja reservado el resto).
create or replace function public.consume_cart_reservation_on_confirm()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_default_wh uuid;
  v_row record;
  v_items jsonb;
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

  select coalesce(jsonb_agg(jsonb_build_object('product_id', soi.product_id, 'quantity', soi.quantity)), '[]'::jsonb)
    into v_items
    from public.sales_order_items soi
   where soi.order_id = new.id and soi.product_id is not null;

  for v_row in
    select d.material_id, sum(d.need) as need
      from public.recipe_demand_lines(new.tenant_id, v_items) d
     group by d.material_id
     order by d.material_id
  loop
    update public.material_reservations mr
       set quantity = greatest(mr.quantity - v_row.need, 0)
     where mr.cart_id = new.cart_id and mr.tenant_id = new.tenant_id and mr.material_id = v_row.material_id;
  end loop;

  delete from public.material_reservations mr
   where mr.cart_id = new.cart_id and mr.tenant_id = new.tenant_id and mr.quantity <= 0;

  return new;
end;
$$;

-- 4f. Expiración de la tienda: también las reservas de insumos.
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
  ), gone_m as (
    delete from public.material_reservations r
     where r.expires_at is not null and r.expires_at <= now()
     returning r.cart_id
  )
  select coalesce(array_agg(distinct cart_id), '{}') into v_carts
    from (select cart_id from gone union all select cart_id from gone_m) u;

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
-- 5. Descuento al confirmar / reversión al anular
-- ---------------------------------------------------------------------------
-- 5a. ÚNICO cambio a la lógica de productos 'stock': un producto 'recipe' no
-- tiene stock propio, así que no emite salida de producto. Idéntica a
-- 20260825134917 salvo `and p.inventory_mode = 'stock'`.
create or replace function public.apply_sales_order_confirmed_stock_effect()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_item record;
  v_default_warehouse_id uuid;
begin
  select id into v_default_warehouse_id
  from public.warehouses
  where tenant_id = new.tenant_id and is_default = true and is_active = true
  limit 1;

  for v_item in
    select soi.product_id, soi.variant_id, soi.warehouse_id, soi.quantity
    from public.sales_order_items soi
    join public.products p on p.id = soi.product_id
    where soi.order_id = new.id and soi.product_id is not null and p.track_inventory = true
      and p.inventory_mode = 'stock'
  loop
    insert into public.stock_movements (tenant_id, product_id, variant_id, warehouse_id, movement_type, quantity, reference_type, reference_id)
    values (new.tenant_id, v_item.product_id, v_item.variant_id, coalesce(v_item.warehouse_id, v_default_warehouse_id), 'salida', v_item.quantity, 'venta', new.id);
  end loop;

  return new;
end;
$function$;

-- 5b. Salida de insumos (trigger hermano). Mismo `when` que el de productos
-- (cualquier transición hacia 'confirmada'), a propósito: la reversión de
-- abajo es NETA (salidas - entradas ya devueltas), así cancelar y reconfirmar
-- es consistente (se descuenta de nuevo). Una fila por (insumo, bodega) con
-- los insumos compartidos entre líneas SUMADOS; unit_cost = costo vigente del
-- insumo. Un insumo inactivo o borrado igual se descuenta (la venta ocurrió).
-- Sin bodega por defecto activa y sin bodega en la línea: falla con mensaje
-- claro (igual que los productos, cuyo NOT NULL revienta la confirmación).
create or replace function public.apply_sales_order_confirmed_materials_effect()
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
    select b.material_id,
           coalesce(soi.warehouse_id, v_default_wh) as warehouse_id,
           sum(soi.quantity * b.quantity) as quantity,
           max(m.cost) as cost
      from public.sales_order_items soi
      join public.products p on p.id = soi.product_id and p.tenant_id = new.tenant_id and p.inventory_mode = 'recipe'
      join public.product_bom b on b.product_id = p.id and b.tenant_id = new.tenant_id
      join public.materials m on m.id = b.material_id and m.tenant_id = new.tenant_id
     where soi.order_id = new.id and soi.product_id is not null and soi.quantity > 0
     group by b.material_id, coalesce(soi.warehouse_id, v_default_wh)
     order by 1, 2
  loop
    if v_row.warehouse_id is null then
      raise exception 'MATERIAL_WAREHOUSE_REQUIRED: No hay bodega por defecto activa para descontar los insumos de la venta.';
    end if;
    insert into public.material_movements (tenant_id, material_id, warehouse_id, movement_type, quantity, unit_cost, reference_type, reference_id)
    values (new.tenant_id, v_row.material_id, v_row.warehouse_id, 'salida', v_row.quantity, v_row.cost, 'venta', new.id);
  end loop;

  return new;
end;
$$;

create trigger trg_sales_orders_confirmed_materials_effect
  after update of status on public.sales_orders
  for each row
  when (new.status = 'confirmada' and old.status is distinct from new.status)
  execute function public.apply_sales_order_confirmed_materials_effect();

-- 5c. Reversión al anular: NETA por (insumo, bodega) = salidas de venta - entradas
-- de venta ya emitidas para ese pedido.
create or replace function public.apply_sales_order_cancelled_materials_effect()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  for v_row in
    select mm.material_id, mm.warehouse_id,
           sum(case mm.movement_type when 'salida' then mm.quantity else -mm.quantity end) as quantity
      from public.material_movements mm
     where mm.tenant_id = new.tenant_id
       and mm.reference_type = 'venta' and mm.reference_id = new.id
       and mm.movement_type in ('salida', 'entrada')
     group by mm.material_id, mm.warehouse_id
    having sum(case mm.movement_type when 'salida' then mm.quantity else -mm.quantity end) > 0
     order by 1, 2
  loop
    insert into public.material_movements (tenant_id, material_id, warehouse_id, movement_type, quantity, reference_type, reference_id)
    values (new.tenant_id, v_row.material_id, v_row.warehouse_id, 'entrada', v_row.quantity, 'venta', new.id);
  end loop;
  return new;
end;
$$;

create trigger trg_sales_orders_cancelled_materials_effect
  after update of status on public.sales_orders
  for each row
  when (new.status = 'cancelada' and old.status in ('confirmada', 'en_proceso', 'entregada'))
  execute function public.apply_sales_order_cancelled_materials_effect();

-- ---------------------------------------------------------------------------
-- 6. guard_sales_order_confirmation: también mira insumos
-- ---------------------------------------------------------------------------
-- Idéntica a 20261026130000 salvo: (1) el chequeo de stock propio solo aplica a
-- productos 'stock'; (2) tras él, los insumos de las líneas 'recipe' (SUMADOS
-- entre líneas) contra disponible = existencias - reservas de OTROS carritos,
-- con el mismo lock por insumo que usa la reserva. Canal 'pos' sigue saltando
-- TODO el bloque (la autoridad del mostrador es pos-checkout/create-order).
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
  v_items jsonb;
  v_mat uuid;
  v_short record;
begin
  if new.sales_channel is distinct from 'pos' then
    for v_item in
      select soi.product_id, soi.variant_id, soi.product_name, soi.quantity
      from public.sales_order_items soi
      join public.products p on p.id = soi.product_id
      where soi.order_id = new.id and soi.product_id is not null and p.track_inventory = true
        and p.inventory_mode = 'stock'
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

    -- Insumos de los productos 'recipe' (después de los productos: mismo orden
    -- de locks que sync_cart_reservations).
    select coalesce(jsonb_agg(jsonb_build_object('product_id', soi.product_id, 'quantity', soi.quantity)), '[]'::jsonb)
      into v_items
      from public.sales_order_items soi
     where soi.order_id = new.id and soi.product_id is not null;

    for v_mat in
      select distinct d.material_id from public.recipe_demand_lines(new.tenant_id, v_items) d order by 1
    loop
      perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text || ':m:' || v_mat::text, 0));
    end loop;

    select * into v_short
      from public.recipe_shortfalls(new.tenant_id, v_items, new.cart_id)
     order by product_id, material_id
     limit 1;
    if found then
      if v_short.material_id is null then
        raise exception 'INSUFFICIENT_STOCK: El producto "%" no tiene ficha técnica y no se puede confirmar.', v_short.product_name;
      end if;
      raise exception 'INSUFFICIENT_STOCK: Insumo insuficiente para confirmar "%": "%" disponible % %, requerido % %.',
        v_short.product_name, v_short.material_name, v_short.material_available, v_short.unit, v_short.material_required, v_short.unit;
    end if;

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

-- ---------------------------------------------------------------------------
-- 7. RPC: listado de insumos con existencias y costo de ficha
-- ---------------------------------------------------------------------------
-- Tenant SIEMPRE desde la sesión. Orden estable por nombre (y id). count
-- = filas totales que cumplen la búsqueda (para paginar). `available` del
-- listado = existencias - reservado, informativo (no mira si el insumo está
-- activo; la disponibilidad que gobierna ventas es material_available).
create or replace function public.get_materials_overview(
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  id uuid,
  name text,
  sku text,
  unit text,
  cost numeric,
  min_stock numeric,
  is_active boolean,
  notes text,
  created_at timestamptz,
  updated_at timestamptz,
  total_quantity numeric,
  reserved numeric,
  available numeric,
  "count" bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with tn as (select public.auth_active_tenant_id() as id),
  base as (
    select m.*
      from public.materials m, tn
     where m.tenant_id = tn.id
       and m.deleted_at is null
       and (
         nullif(btrim(p_search), '') is null
         or position(lower(btrim(p_search)) in lower(m.name)) > 0
         or position(lower(btrim(p_search)) in lower(coalesce(m.sku, ''))) > 0
       )
  )
  select b.id, b.name, b.sku, b.unit, b.cost, b.min_stock, b.is_active, b.notes, b.created_at, b.updated_at,
         s.q, r.q, greatest(s.q - r.q, 0),
         count(*) over ()
    from base b
    cross join lateral (
      select coalesce(sum(ms.quantity), 0) as q from public.material_stock ms
       where ms.material_id = b.id and ms.tenant_id = b.tenant_id
    ) s
    cross join lateral (
      select coalesce(sum(mr.quantity), 0) as q from public.material_reservations mr
       where mr.material_id = b.id and mr.tenant_id = b.tenant_id
         and (mr.expires_at is null or mr.expires_at > now())
    ) r
   order by lower(b.name), b.id
   limit greatest(least(coalesce(p_limit, 50), 200), 1)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

-- Costo calculado de la ficha (informativo): sum(cantidad x costo del insumo).
create or replace function public.get_product_bom_cost(p_product_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(b.quantity * m.cost), 0)
    from public.product_bom b
    join public.materials m on m.id = b.material_id and m.tenant_id = b.tenant_id
   where b.product_id = p_product_id
     and b.tenant_id = public.auth_active_tenant_id()
$$;

-- ---------------------------------------------------------------------------
-- 8. Privilegios
-- ---------------------------------------------------------------------------
revoke execute on function public.material_available(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.recipe_demand_lines(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.recipe_shortfalls(uuid, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.recipe_availability_rows(uuid, uuid[], uuid) from public, anon, authenticated;
revoke execute on function public.sync_cart_material_reservations(uuid, uuid, timestamptz, boolean) from public, anon, authenticated;
revoke execute on function public.apply_sales_order_confirmed_materials_effect() from public, anon, authenticated;
revoke execute on function public.apply_sales_order_cancelled_materials_effect() from public, anon, authenticated;
grant execute on function public.material_available(uuid, uuid, uuid) to service_role;
grant execute on function public.recipe_demand_lines(uuid, jsonb) to service_role;
grant execute on function public.recipe_shortfalls(uuid, jsonb, uuid) to service_role;
grant execute on function public.recipe_availability_rows(uuid, uuid[], uuid) to service_role;

-- CREATE OR REPLACE de funciones ya existentes conserva sus grants; se repiten
-- los revoke por si el entorno los hubiera perdido.
revoke execute on function public.sync_cart_reservations(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.cart_desired_reservations(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.carts_release_reservations() from public, anon, authenticated;
revoke execute on function public.consume_cart_reservation_on_confirm() from public, anon, authenticated;
revoke execute on function public.expire_storefront_reservations() from public, anon, authenticated;
revoke execute on function public.stock_availability_rows(uuid, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.sync_cart_reservations(uuid, boolean) to service_role;
grant execute on function public.stock_availability_rows(uuid, uuid[], uuid) to service_role;
revoke execute on function public.apply_sales_order_confirmed_stock_effect() from public, anon, authenticated;
revoke execute on function public.guard_sales_order_confirmation() from public, anon, authenticated;

revoke execute on function public.get_materials_overview(text, integer, integer) from public, anon;
revoke execute on function public.get_product_bom_cost(uuid) from public, anon;
grant execute on function public.get_materials_overview(text, integer, integer) to authenticated, service_role;
grant execute on function public.get_product_bom_cost(uuid) to authenticated, service_role;
