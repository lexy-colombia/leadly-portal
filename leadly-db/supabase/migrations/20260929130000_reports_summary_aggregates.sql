-- RPCs de agregación para el módulo "Reportes" (balance financiero +
-- reportes de producto), pedido explícito del usuario 2026-09-29. Mismo
-- patrón de seguridad que get_sales_orders_summary/get_expenses_summary:
-- sin RLS (el service role la bypassea igual), filtro de tenant_id EXPLÍCITO
-- adentro de cada CTE que toca una tabla nueva (no confiar en que el join
-- por order_id/invoice_id ya esté tenant-scoped -- mismo criterio de
-- defensa en profundidad que ya usan esas dos funciones), revoke a public,
-- grant solo a service_role. Invocadas solo desde reports-summary, que
-- resuelve p_tenant_id del JWT del caller (nunca del body).
--
-- Convención de rango de fechas: [p_date_from, p_date_to) -- igual que
-- get_sales_orders_summary (o.created_at < $6). El caller (Edge Function)
-- es responsable de mandar p_date_to como el instante EXCLUSIVO de cierre
-- (ej. medianoche del día siguiente al último día del rango), no el último
-- día inclusive.

-- =====================================================================
-- get_reports_financial_summary
-- =====================================================================
create or replace function public.get_reports_financial_summary(
  p_tenant_id uuid,
  p_date_from timestamptz,
  p_date_to timestamptz
)
returns jsonb
language sql
stable
set search_path = public
as $$
  with orders_base as (
    select o.*
    from public.sales_orders o
    where o.tenant_id = p_tenant_id
      and o.deleted_at is null
      and o.status = 'confirmada'
      and o.created_at >= p_date_from
      and o.created_at < p_date_to
  ),
  by_method as (
    select p.method, sum(p.amount) as amount
    from public.sales_order_payments p
    join orders_base o on o.id = p.order_id
    where p.tenant_id = p_tenant_id and p.deleted_at is null
    group by p.method
  ),
  by_channel as (
    select coalesce(o.sales_channel, 'sin_canal') as channel, sum(o.total) as amount
    from orders_base o
    group by coalesce(o.sales_channel, 'sin_canal')
  ),
  invoiced as (
    select
      coalesce(sum(total) filter (where has_invoice), 0) as invoiced_total,
      count(*) filter (where has_invoice) as invoiced_count,
      coalesce(sum(total) filter (where not has_invoice), 0) as not_invoiced_total,
      count(*) filter (where not has_invoice) as not_invoiced_count
    from orders_base
  ),
  -- has_invoice=true ya significa "la DIAN aceptó/recibió esta factura de
  -- verdad" (ver 20260908120000), así que una nota crédito solo se cuenta si
  -- la orden que corrige sigue confirmada y cayó en el rango (join contra
  -- orders_base, no contra la fecha propia de la nota crédito -- sigue el
  -- criterio explícito del plan).
  credit_notes as (
    select coalesce(sum(cn.total), 0) as total
    from public.sales_credit_notes cn
    join orders_base o on o.id = cn.order_id
    where cn.tenant_id = p_tenant_id and cn.status = 'accepted'
  ),
  -- returns.tenant_id existe directo en la tabla (verificado leyendo
  -- 20260823020001_returns.sql) -- no hace falta un join a sales_orders solo
  -- para filtrar tenant.
  returns_agg as (
    select coalesce(sum(r.resolution_amount), 0) as total
    from public.returns r
    where r.tenant_id = p_tenant_id
      and r.resolution_amount is not null
      and r.created_at >= p_date_from
      and r.created_at < p_date_to
  ),
  expenses_base as (
    select e.*
    from public.expenses e
    where e.tenant_id = p_tenant_id
      and e.deleted_at is null
      and e.expense_date >= p_date_from::date
      and e.expense_date < p_date_to::date
  ),
  expenses_totals as (
    select
      coalesce(sum(amount) filter (where status = 'pagado'), 0) as paid_total,
      count(*) filter (where status = 'pagado') as paid_count,
      coalesce(sum(amount) filter (where status = 'pendiente'), 0) as pending_total,
      count(*) filter (where status = 'pendiente') as pending_count
    from expenses_base
  ),
  expenses_by_category as (
    select coalesce(ec.name, 'sin_categoria') as category_name, sum(e.amount) as amount
    from expenses_base e
    left join public.expense_categories ec on ec.id = e.category_id
    group by coalesce(ec.name, 'sin_categoria')
  )
  select jsonb_build_object(
    'income_total', coalesce((select sum(total) from orders_base), 0),
    'income_count', (select count(*) from orders_base),
    'by_method', coalesce((select jsonb_object_agg(method, amount) from by_method), '{}'::jsonb),
    'by_channel', coalesce((select jsonb_object_agg(channel, amount) from by_channel), '{}'::jsonb),
    'invoiced_total', (select invoiced_total from invoiced),
    'invoiced_count', (select invoiced_count from invoiced),
    'not_invoiced_total', (select not_invoiced_total from invoiced),
    'not_invoiced_count', (select not_invoiced_count from invoiced),
    'credit_notes_total', (select total from credit_notes),
    'returns_total', (select total from returns_agg),
    'expenses_paid_total', (select paid_total from expenses_totals),
    'expenses_paid_count', (select paid_count from expenses_totals),
    'expenses_pending_total', (select pending_total from expenses_totals),
    'expenses_pending_count', (select pending_count from expenses_totals),
    'expenses_by_category', coalesce((select jsonb_object_agg(category_name, amount) from expenses_by_category), '{}'::jsonb),
    -- Egresos PENDIENTES no restan del balance de caja real -- son un
    -- compromiso futuro, no un egreso ya ocurrido (decisión explícita del
    -- plan).
    'net_balance',
      coalesce((select sum(total) from orders_base), 0)
      - (select total from credit_notes)
      - (select total from returns_agg)
      - (select paid_total from expenses_totals),
    'currency', coalesce((select currency from orders_base limit 1), 'COP')
  );
$$;

revoke all on function public.get_reports_financial_summary(uuid, timestamptz, timestamptz) from public;
grant execute on function public.get_reports_financial_summary(uuid, timestamptz, timestamptz) to service_role;

-- =====================================================================
-- get_reports_product_summary
-- =====================================================================
create or replace function public.get_reports_product_summary(
  p_tenant_id uuid,
  p_date_from timestamptz,
  p_date_to timestamptz,
  p_limit integer default 10,
  p_stale_days integer default 30
)
returns jsonb
language sql
stable
set search_path = public
as $$
  with items_base as (
    -- coalesce(product_id::text, 'name:' || product_name) como clave de
    -- agrupación: una línea sin product_id (migrada de Fudo, o de un
    -- producto ya borrado) nunca se fusiona con otra línea sin product_id de
    -- nombre distinto, pero SÍ se incluye en el ranking por su product_name
    -- (nunca se descarta).
    select
      coalesce(i.product_id::text, 'name:' || i.product_name) as product_key,
      i.product_id,
      i.product_name,
      i.quantity,
      i.subtotal,
      o.created_at
    from public.sales_order_items i
    join public.sales_orders o on o.id = i.order_id
    where o.tenant_id = p_tenant_id
      and o.deleted_at is null
      and o.status = 'confirmada'
      and o.created_at >= p_date_from
      and o.created_at < p_date_to
  ),
  per_product as (
    select
      product_key,
      -- Todas las filas de un mismo product_key comparten el mismo
      -- product_id (ambos null, o el mismo uuid) y por construcción el
      -- mismo product_name cuando product_id es null -- uuid no tiene
      -- max()/min() agregado en Postgres, así que se toma el primero del
      -- grupo con array_agg (nunca mezcla valores distintos, son iguales).
      (array_agg(product_id))[1] as product_id,
      (array_agg(product_name))[1] as product_name,
      sum(quantity) as quantity,
      sum(subtotal) as revenue
    from items_base
    group by product_key
  ),
  top_qty as (
    select * from per_product order by quantity desc limit p_limit
  ),
  top_rev as (
    select * from per_product order by revenue desc limit p_limit
  ),
  day_series_range as (
    select generate_series(p_date_from::date, (p_date_to - interval '1 day')::date, interval '1 day')::date as day
  ),
  daily_agg as (
    select created_at::date as day, sum(quantity) as quantity, sum(subtotal) as revenue
    from items_base
    group by created_at::date
  ),
  daily as (
    -- Un día sin ventas dentro del rango aparece con quantity/revenue en
    -- cero, nunca se omite (mismo criterio de "día cero visible" que
    -- bucketByDay/valueByDay en Dashboard.tsx).
    select
      ds.day,
      coalesce(da.quantity, 0) as quantity,
      coalesce(da.revenue, 0) as revenue
    from day_series_range ds
    left join daily_agg da on da.day = ds.day
  ),
  -- products.category_id ya NO existe (se movió a product_category_links,
  -- muchos-a-muchos, ver 20260817210500 -- el plan asumía la columna 1:1
  -- vieja, corregido acá tras confirmar el error al aplicar la migración
  -- contra la base real). Un producto en más de una categoría suma su
  -- cantidad/revenue en cada una (mismo criterio que cualquier reporte de
  -- ventas por categoría con productos multi-categoría) -- "sin_categoria"
  -- es solo para un producto sin NINGÚN link, o una línea sin product_id.
  by_category_raw as (
    select
      coalesce(pc.name, 'sin_categoria') as category_name,
      sum(ib.quantity) as quantity,
      sum(ib.subtotal) as revenue
    from items_base ib
    left join public.product_category_links pcl on pcl.product_id = ib.product_id and pcl.tenant_id = p_tenant_id
    left join public.product_categories pc on pc.id = pcl.category_id and pc.tenant_id = p_tenant_id
    group by coalesce(pc.name, 'sin_categoria')
  ),
  by_brand_raw as (
    select
      coalesce(b.name, 'sin_marca') as brand_name,
      sum(ib.quantity) as quantity,
      sum(ib.subtotal) as revenue
    from items_base ib
    left join public.products p on p.id = ib.product_id and p.tenant_id = p_tenant_id
    left join public.brands b on b.id = p.brand_id and b.tenant_id = p_tenant_id
    group by coalesce(b.name, 'sin_marca')
  ),
  -- "Sin ventas recientes" es una propiedad ABSOLUTA del producto, no del
  -- rango del reporte -- se mira contra TODAS las órdenes confirmadas
  -- históricas del tenant, sin limitar a [p_date_from, p_date_to).
  last_sale as (
    select i.product_id, max(o.created_at) as last_sale_at
    from public.sales_order_items i
    join public.sales_orders o on o.id = i.order_id
    where o.tenant_id = p_tenant_id
      and o.deleted_at is null
      and o.status = 'confirmada'
      and i.product_id is not null
    group by i.product_id
  ),
  stale as (
    select p.id as product_id, p.name as product_name, ls.last_sale_at
    from public.products p
    left join last_sale ls on ls.product_id = p.id
    where p.tenant_id = p_tenant_id
      and p.deleted_at is null
      and p.is_active = true
      and (ls.last_sale_at is null or ls.last_sale_at < now() - (p_stale_days || ' days')::interval)
    order by ls.last_sale_at asc nulls first, p.name asc
    limit 20
  ),
  -- Margen bruto sobre el mismo top N de top_rev (no una consulta aparte).
  -- purchase_price null = costo DESCONOCIDO, nunca se asume 0.
  margin as (
    select
      tr.product_id,
      tr.product_name,
      tr.revenue,
      tr.quantity,
      p.purchase_price
    from top_rev tr
    left join public.products p on p.id = tr.product_id and p.tenant_id = p_tenant_id
  )
  select jsonb_build_object(
    'top_by_quantity', coalesce(
      (select jsonb_agg(jsonb_build_object(
        'product_id', product_id, 'product_name', product_name, 'quantity', quantity, 'revenue', revenue
      ) order by quantity desc) from top_qty),
      '[]'::jsonb
    ),
    'top_by_revenue', coalesce(
      (select jsonb_agg(jsonb_build_object(
        'product_id', product_id, 'product_name', product_name, 'quantity', quantity, 'revenue', revenue
      ) order by revenue desc) from top_rev),
      '[]'::jsonb
    ),
    'daily_series', coalesce(
      (select jsonb_agg(jsonb_build_object('date', day, 'quantity', quantity, 'revenue', revenue) order by day) from daily),
      '[]'::jsonb
    ),
    'by_category', coalesce(
      (select jsonb_object_agg(category_name, jsonb_build_object('quantity', quantity, 'revenue', revenue)) from by_category_raw),
      '{}'::jsonb
    ),
    'by_brand', coalesce(
      (select jsonb_object_agg(brand_name, jsonb_build_object('quantity', quantity, 'revenue', revenue)) from by_brand_raw),
      '{}'::jsonb
    ),
    'stale_products', coalesce(
      (select jsonb_agg(jsonb_build_object('product_id', product_id, 'product_name', product_name, 'last_sale_at', last_sale_at)) from stale),
      '[]'::jsonb
    ),
    'gross_margin', coalesce(
      (select jsonb_agg(jsonb_build_object(
        'product_id', product_id,
        'product_name', product_name,
        'revenue', revenue,
        'estimated_cost', case when purchase_price is null then null else quantity * purchase_price end,
        'estimated_margin', case when purchase_price is null then null else revenue - (quantity * purchase_price) end
      ) order by revenue desc) from margin),
      '[]'::jsonb
    )
  );
$$;

revoke all on function public.get_reports_product_summary(uuid, timestamptz, timestamptz, integer, integer) from public;
grant execute on function public.get_reports_product_summary(uuid, timestamptz, timestamptz, integer, integer) to service_role;
