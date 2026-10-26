-- Margen bruto del reporte de productos con costo de ficha tecnica (brief: progress/brief_margen_recetas.md).
-- Redefine SOLO get_reports_product_summary (misma firma, mismas claves; gross_margin gana la clave
-- por fila `cost_source`). La definicion vigente es la de 20260929140000; todo lo demas se conserva identico.
--
-- Regla de costo:
--   * inventory_mode = 'stock' (o producto inexistente/linea libre): costo unitario = products.purchase_price
--     (null -> costo desconocido), IGUAL que antes. cost_source = 'purchase_price' (null si desconocido).
--   * inventory_mode = 'recipe': costo unitario = sum(product_bom.quantity * materials.cost) con el costo
--     VIGENTE del insumo. cost_source = 'recipe'.
--   * COSTO DESCONOCIDO (estimated_cost/estimated_margin null, cost_source null) cuando la ficha esta vacia,
--     o algun insumo tiene cost = 0, o algun insumo de la ficha no se resuelve dentro del tenant. Un costo
--     parcial (insumo en 0) NO se presenta como margen del 100%.
--   * Insumo retirado (materials.deleted_at not null): NO se excluye. Su costo sigue siendo un hecho conocido de
--     lo vendido; excluirlo subestimaria el costo e inflaria el margen.
--   * tenant_id explicito en product_bom y materials (la funcion no tiene RLS: security invoker + service_role).

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
  -- FIX 1: p_date_to es el límite EXCLUSIVO del rango, pero no
  -- necesariamente está alineado a medianoche (ej. "hoy hasta ahora", o
  -- cualquier rango de menos de 24h) -- restar exactamente 1 día asumía esa
  -- alineación y podía devolver un stop-date ANTERIOR al start-date
  -- (generate_series da 0 filas en silencio) o perder el último día
  -- calendario de un rango que cruza medianoche sin ser múltiplo exacto de
  -- 24h. Restar 1 microsegundo en vez de 1 día captura siempre el último
  -- día calendario dentro de [p_date_from, p_date_to) sin depender de
  -- alineación -- con p_date_to > p_date_from ya garantizado por la Edge
  -- Function, ese día siempre es >= p_date_from::date.
  day_series_range as (
    select generate_series(p_date_from::date, (p_date_to - interval '1 microsecond')::date, interval '1 day')::date as day
  ),
  daily_agg as (
    select created_at::date as day, sum(quantity) as quantity, sum(subtotal) as revenue
    from items_base
    group by created_at::date
  ),
  daily as (
    select
      ds.day,
      coalesce(da.quantity, 0) as quantity,
      coalesce(da.revenue, 0) as revenue
    from day_series_range ds
    left join daily_agg da on da.day = ds.day
  ),
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
  recipe_cost as (
    select
      tr.product_id,
      count(pb.id) as bom_lines,
      sum(pb.quantity * m.cost) as unit_cost,
      coalesce(bool_or(m.id is null or m.cost = 0), false) as has_unknown_input
    from top_rev tr
    join public.products p on p.id = tr.product_id and p.tenant_id = p_tenant_id and p.inventory_mode = 'recipe'
    left join public.product_bom pb on pb.product_id = p.id and pb.tenant_id = p_tenant_id
    left join public.materials m on m.id = pb.material_id and m.tenant_id = p_tenant_id
    group by tr.product_id
  ),
  margin as (
    select
      tr.product_id,
      tr.product_name,
      tr.revenue,
      tr.quantity,
      case
        when p.inventory_mode = 'recipe' then
          case when rc.bom_lines > 0 and not rc.has_unknown_input then rc.unit_cost end
        else p.purchase_price
      end as unit_cost,
      case
        when p.inventory_mode = 'recipe' then
          case when rc.bom_lines > 0 and not rc.has_unknown_input then 'recipe' end
        when p.purchase_price is not null then 'purchase_price'
      end as cost_source
    from top_rev tr
    left join public.products p on p.id = tr.product_id and p.tenant_id = p_tenant_id
    left join recipe_cost rc on rc.product_id = tr.product_id
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
        'estimated_cost', case when unit_cost is null then null else quantity * unit_cost end,
        'estimated_margin', case when unit_cost is null then null else revenue - (quantity * unit_cost) end,
        'cost_source', cost_source
      ) order by revenue desc) from margin),
      '[]'::jsonb
    )
  );
$$;

revoke all on function public.get_reports_product_summary(uuid, timestamptz, timestamptz, integer, integer) from public;
grant execute on function public.get_reports_product_summary(uuid, timestamptz, timestamptz, integer, integer) to service_role;
