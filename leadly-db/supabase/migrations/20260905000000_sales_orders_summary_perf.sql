-- Reescribe get_sales_orders_summary (20260904220000) para un solo pase --
-- la versión original hacía 4 joins redundantes por separado (uno por cada
-- campo del jsonb_build_object final: count/paid/pending), cada uno
-- recalculando confirmed × paid_by_order desde cero. Con un tenant real ya
-- en 28.000 pedidos / 27.000 pagos (migración de Fudo, 2026-09-05) esto
-- empezó a tardar lo suficiente para que la propia consola de Supabase la
-- cortara por timeout -- la pantalla de Órdenes depende de esta función en
-- cada carga, así que el problema era real, no solo de una herramienta de
-- diagnóstico. Un solo join agregado (`per_order`) resuelve paid/pending
-- por orden una sola vez, reutilizado por todo lo demás.
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
language sql
stable
set search_path = public
as $$
  with base as (
    select o.*
    from public.sales_orders o
    where o.tenant_id = p_tenant_id
      and o.deleted_at is null
      and (p_status is null or o.status = p_status)
      and (p_channel is null or o.sales_channel = p_channel)
      and (p_contact_id is null or o.contact_id = p_contact_id)
      and (p_date_from is null or o.created_at >= p_date_from)
      and (p_date_to is null or o.created_at < p_date_to)
      and (
        (p_search_number is null and p_search_contact_ids is null)
        or (p_search_number is not null and o.number = p_search_number)
        or (p_search_contact_ids is not null and o.contact_id = any (p_search_contact_ids))
      )
  ),
  confirmed as (
    select id, total, currency, pos_table from base where status = 'confirmada'
  ),
  paid_by_order as (
    select p.order_id, sum(p.amount) as paid
    from public.sales_order_payments p
    join confirmed c on c.id = p.order_id
    where p.tenant_id = p_tenant_id and p.deleted_at is null
    group by p.order_id
  ),
  -- Un solo join: paid/pending por orden resueltos acá una vez, no
  -- recalculados por separado en cada campo del resultado final.
  per_order as (
    select
      c.id,
      c.total,
      c.pos_table,
      least(c.total, coalesce(pbo.paid, 0)) as paid,
      greatest(c.total - coalesce(pbo.paid, 0), 0) as pending
    from confirmed c
    left join paid_by_order pbo on pbo.order_id = c.id
  ),
  by_method as (
    select p.method, sum(p.amount) as amount
    from public.sales_order_payments p
    join confirmed c on c.id = p.order_id
    where p.tenant_id = p_tenant_id and p.deleted_at is null
    group by p.method
  ),
  tables as (
    select pos_table, count(*) as cnt, sum(total) as total
    from per_order
    where pos_table is not null
    group by pos_table
    order by sum(total) desc
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
    'top_tables', coalesce((select jsonb_agg(jsonb_build_object('table', pos_table, 'count', cnt, 'total', total)) from tables), '[]'::jsonb)
  )
  from totals t;
$$;
