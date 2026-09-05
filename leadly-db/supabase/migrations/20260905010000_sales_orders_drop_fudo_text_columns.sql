-- Las 6 columnas de texto libre agregadas en 20260904203730 (pos_table,
-- pos_room, party_size, server_name, sale_type, payment_method_label) para
-- guardar el detalle de mesa/mesero de la migración de Fudo nunca se
-- llegaron a poblar -- pedido explícito del usuario 2026-09-05: usar la
-- relación real que ya existe (sales_orders.pos_point_id -> pos_points,
-- el mismo catálogo de "puntos de venta" que ya usa el POS en vivo) en vez
-- de texto libre, y borrar las columnas viejas.
--
-- get_sales_orders_summary (última versión: 20260905000100) lee `pos_table`
-- directo para el ranking "top mesas" -- se reescribe para leer
-- `pos_point_id` + un join a `pos_points.name` antes de poder dropear la
-- columna, si no la función revienta en cada carga de la pantalla Ventas
-- (list-sales-orders la llama en cada request).
create or replace function public.get_sales_orders_summary(
  p_tenant_id uuid,
  p_status text default null,
  p_channel text default null,
  p_contact_id uuid default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_search_number integer default null,
  p_search_contact_ids uuid[] default null
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  result jsonb;
begin
  execute $sql$
    with base as (
      select o.*
      from public.sales_orders o
      where o.tenant_id = $1
        and o.deleted_at is null
        and ($2::text is null or o.status = $2)
        and ($3::text is null or o.sales_channel = $3)
        and ($4::uuid is null or o.contact_id = $4)
        and ($5::timestamptz is null or o.created_at >= $5)
        and ($6::timestamptz is null or o.created_at < $6)
        and (
          ($7::integer is null and $8::uuid[] is null)
          or ($7::integer is not null and o.number = $7)
          or ($8::uuid[] is not null and o.contact_id = any ($8))
        )
    ),
    confirmed as (
      select id, total, currency, pos_point_id from base where status = 'confirmada'
    ),
    paid_by_order as (
      select p.order_id, sum(p.amount) as paid
      from public.sales_order_payments p
      join confirmed c on c.id = p.order_id
      where p.tenant_id = $1 and p.deleted_at is null
      group by p.order_id
    ),
    per_order as (
      select
        c.id,
        c.total,
        c.pos_point_id,
        least(c.total, coalesce(pbo.paid, 0)) as paid,
        greatest(c.total - coalesce(pbo.paid, 0), 0) as pending
      from confirmed c
      left join paid_by_order pbo on pbo.order_id = c.id
    ),
    by_method as (
      select p.method, sum(p.amount) as amount
      from public.sales_order_payments p
      join confirmed c on c.id = p.order_id
      where p.tenant_id = $1 and p.deleted_at is null
      group by p.method
    ),
    tables as (
      select pp.name as pos_point_name, count(*) as cnt, sum(po.total) as total
      from per_order po
      join public.pos_points pp on pp.id = po.pos_point_id
      group by pp.name
      order by sum(po.total) desc
      limit 8
    ),
    totals as (
      select
        count(*) as cnt,
        coalesce(sum(total), 0) as total,
        coalesce(sum(paid), 0) as paid,
        coalesce(sum(pending), 0) as pending
      from per_order
    )
    select jsonb_build_object(
      'count', t.cnt,
      'total', t.total,
      'currency', coalesce((select currency from confirmed limit 1), 'COP'),
      'paid', t.paid,
      'pending', t.pending,
      'by_method', coalesce((select jsonb_object_agg(method, amount) from by_method), '{}'::jsonb),
      'top_tables', coalesce((select jsonb_agg(jsonb_build_object('table', pos_point_name, 'count', cnt, 'total', total)) from tables), '[]'::jsonb)
    )
    from totals t
  $sql$
  into result
  using p_tenant_id, p_status, p_channel, p_contact_id, p_date_from, p_date_to, p_search_number, p_search_contact_ids;

  return result;
end;
$$;

alter table public.sales_orders
  drop column if exists pos_table,
  drop column if exists pos_room,
  drop column if exists party_size,
  drop column if exists server_name,
  drop column if exists sale_type,
  drop column if exists payment_method_label;
