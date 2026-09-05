-- Soporte para la Edge Function `list-sales-orders`: agrega en el servidor
-- (count/sum/group by) los tiles de resumen de Orders.tsx (total vendido,
-- pagado, pendiente, desglose por método de pago, ranking de mesas) que
-- antes se calculaban en el navegador sobre el array COMPLETO de órdenes
-- del tenant. Un tenant real llegó a 23.051 pedidos -- traer eso al cliente
-- para sumarlo, o incluso al Edge Function para sumarlo en JS, no escala;
-- una sola consulta de agregación en Postgres sí, sin importar cuántas
-- filas tenga la tabla.
--
-- Se llama únicamente desde list-sales-orders con el service role -- no
-- aplica RLS (el service role la bypassa igual), así que el filtro por
-- tenant_id es explícito acá adentro, mismo criterio que ya usa
-- calculate-order con el admin client. No se expone a `authenticated`/
-- `anon`: nadie puede invocarla directo pasando el tenant_id de otro.
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
  -- Igual que salesSummary/topTables en Orders.tsx: siempre solo
  -- 'confirmada' (ventas reales) sin importar el filtro de estado de arriba
  -- -- si el usuario filtra por 'cotizacion', el resumen queda en cero a
  -- propósito, mismo comportamiento que antes de este cambio.
  confirmed as (
    select * from base where status = 'confirmada'
  ),
  pay as (
    select p.order_id, p.method, p.amount
    from public.sales_order_payments p
    where p.tenant_id = p_tenant_id
      and p.deleted_at is null
      and p.order_id in (select id from confirmed)
  ),
  paid_by_order as (
    select order_id, sum(amount) as paid from pay group by order_id
  ),
  by_method as (
    select method, sum(amount) as amount from pay group by method
  ),
  tables as (
    select pos_table, count(*) as cnt, sum(total) as total
    from confirmed
    where pos_table is not null
    group by pos_table
    order by sum(total) desc
    limit 8
  )
  select jsonb_build_object(
    'count', (select count(*) from confirmed),
    'total', coalesce((select sum(total) from confirmed), 0),
    'currency', coalesce((select currency from confirmed limit 1), 'COP'),
    -- paid/pending por orden, clipeado a [0, total] -- mismo criterio que
    -- el useMemo original (un pago que sobrepasa el total de la orden no
    -- infla "pagado" más allá de lo vendido).
    'paid', coalesce((select sum(least(c.total, coalesce(pbo.paid, 0))) from confirmed c left join paid_by_order pbo on pbo.order_id = c.id), 0),
    'pending', coalesce((select sum(greatest(c.total - coalesce(pbo.paid, 0), 0)) from confirmed c left join paid_by_order pbo on pbo.order_id = c.id), 0),
    'by_method', coalesce((select jsonb_object_agg(method, amount) from by_method), '{}'::jsonb),
    'top_tables', coalesce((select jsonb_agg(jsonb_build_object('table', pos_table, 'count', cnt, 'total', total)) from tables), '[]'::jsonb)
  );
$$;

revoke all on function public.get_sales_orders_summary(uuid, text, text, uuid, timestamptz, timestamptz, integer, uuid[]) from public;
grant execute on function public.get_sales_orders_summary(uuid, text, text, uuid, timestamptz, timestamptz, integer, uuid[]) to service_role;
