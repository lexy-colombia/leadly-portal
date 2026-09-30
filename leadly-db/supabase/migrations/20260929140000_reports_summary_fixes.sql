-- Corrige dos defectos bloqueantes encontrados en el review independiente
-- de 20260929130000_reports_summary_aggregates.sql (ver
-- progress/feature_reports_module_backend_review.md). Se deja la migración
-- original TAL CUAL quedó aplicada (correcta como historial de lo que
-- realmente corrió primero) y se corrige acá con `create or replace
-- function`, mismo patrón ya usado en este repo para corregir una función
-- ya desplegada (ver 20260908120000_sales_orders_has_invoice.sql ->
-- 20260912183835_orders_summary_open_carts.sql sobre
-- get_sales_orders_summary).
--
-- 1. get_reports_product_summary::day_series_range restaba exactamente
--    1 día a p_date_to asumiendo que el rango estaba alineado a medianoche.
--    Con cualquier rango de menos de 24h (ej. "hoy hasta ahora") el
--    stop-date quedaba ANTES del start-date y generate_series devolvía 0
--    filas en silencio (daily_series: [] aunque hubiera ventas reales); con
--    un rango que cruza medianoche sin ser múltiplo exacto de 24h, se
--    perdía el último día calendario del desglose diario (aunque seguía
--    contado en los totales globales). Restar 1 microsegundo en vez de
--    1 día captura siempre el último día calendario dentro de
--    [p_date_from, p_date_to) sin depender de alineación.
-- 2. get_reports_financial_summary::expenses_by_category sumaba
--    sum(e.amount) sobre TODO expenses_base sin filtrar status, a
--    diferencia de expenses_totals (que sí excluye 'anulado') -- la suma
--    del desglose por categoría no reconciliaba con expenses_paid_total +
--    expenses_pending_total (confirmado con datos reales de Barriles: la
--    diferencia era exactamente el monto anulado). Se agrega el mismo
--    filtro, más ec.tenant_id = p_tenant_id explícito en el join (el único
--    join de todo el archivo que no lo tenía -- hallazgo informativo del
--    mismo review, se alinea de una vez ya que se toca esta CTE).

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
  credit_notes as (
    select coalesce(sum(cn.total), 0) as total
    from public.sales_credit_notes cn
    join orders_base o on o.id = cn.order_id
    where cn.tenant_id = p_tenant_id and cn.status = 'accepted'
  ),
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
  -- FIX 2: excluye 'anulado' (igual que expenses_totals) y agrega
  -- ec.tenant_id = p_tenant_id explícito en el join.
  expenses_by_category as (
    select coalesce(ec.name, 'sin_categoria') as category_name, sum(e.amount) as amount
    from expenses_base e
    left join public.expense_categories ec on ec.id = e.category_id and ec.tenant_id = p_tenant_id
    where e.status <> 'anulado'
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
