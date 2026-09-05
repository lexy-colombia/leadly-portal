-- get_sales_orders_summary (20260904220000, optimizada en 20260905000000)
-- seguía colgándose (statement timeout) para el tenant recién migrado de
-- Fudo (28.000 pedidos / 27.000 pagos) a pesar de que la MISMA lógica como
-- SQL plano (sin la función) corre instantánea. Causa real: al ser
-- `language sql`, Postgres cachea un plan "genérico" para la función
-- (sin conocer los valores reales de los parámetros) después de las
-- primeras ejecuciones -- en una tabla multi-tenant con distribución muy
-- despareja (un tenant con 28.000 filas contra el resto con unas pocas
-- decenas/cientos), ese plan genérico elige un nested loop en vez de un
-- hash join y explota en tiempo para el tenant grande. Se reescribe como
-- `plpgsql` con `execute ... using` -- fuerza a Postgres a replanificar
-- con los valores reales de los parámetros en cada llamada, en vez de
-- reusar un plan cacheado que asume una tabla pequeña.
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
      select id, total, currency, pos_table from base where status = 'confirmada'
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
      where p.tenant_id = $1 and p.deleted_at is null
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
    from totals t
  $sql$
  into result
  using p_tenant_id, p_status, p_channel, p_contact_id, p_date_from, p_date_to, p_search_number, p_search_contact_ids;

  return result;
end;
$$;
