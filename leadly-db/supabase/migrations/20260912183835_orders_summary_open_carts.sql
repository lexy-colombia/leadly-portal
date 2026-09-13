-- Resumen de la pantalla "Órdenes": suma las cuentas abiertas del POS y
-- saca el ranking de mesas.
--
-- Motivo (reporte real de Barriles de la sexta, 2026-09-12): el resumen solo
-- contaba pedidos ya cobrados, así que con 7 cuentas abiertas llenas en
-- mostrador el comercio veía "8 pedidos" y "Pendiente por cobrar: $0" --
-- lo digitado pero todavía sin cobrar era invisible. Una cuenta abierta es
-- un `carts` (status='open'), no una fila de `sales_orders`, hasta que se
-- cobra, así que se agrega aparte (`open_carts_count`/`open_carts_total`)
-- en vez de mezclarla en `count`/`total`: el frontend decide cómo sumarla.
--
-- Valor de una cuenta = Σ(cantidad × precio − descuento de línea) + envío,
-- el mismo cálculo que computeOrderTotals (el precio ya incluye impuesto).
-- Solo cuentan carritos con al menos un ítem (uno vacío no es una venta).
--
-- Las cuentas abiertas solo se incluyen cuando el filtro activo puede
-- aplicarles: sin filtro de estado (no son un pedido en ningún estado), sin
-- búsqueda por número de pedido (no tienen uno) y sin "solo facturadas".
-- Origen, cliente y rango de fechas sí se aplican (carts.origin usa los
-- mismos valores que sales_orders.sales_channel).
--
-- `top_tables` se elimina a pedido explícito del usuario.

create or replace function public.get_sales_orders_summary(
  p_tenant_id uuid,
  p_status text default null,
  p_channel text default null,
  p_contact_id uuid default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_search_number integer default null,
  p_search_contact_ids uuid[] default null,
  p_has_invoice boolean default null
)
returns jsonb
language plpgsql
stable
set search_path to 'public'
as $function$
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
        and ($9::boolean is null or o.has_invoice = $9)
    ),
    confirmed as (
      select id, total, currency, has_invoice from base where status = 'confirmada'
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
        c.has_invoice,
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
    totals as (
      select
        count(*) as cnt,
        coalesce(sum(total), 0) as total,
        coalesce(sum(paid), 0) as paid,
        coalesce(sum(pending), 0) as pending,
        count(*) filter (where has_invoice) as invoiced_cnt,
        coalesce(sum(total) filter (where has_invoice), 0) as invoiced_total
      from per_order
    ),
    open_carts as (
      select c.id, coalesce(c.shipping, 0) + sum(ci.quantity * ci.unit_price - coalesce(ci.discount_amount, 0)) as total
      from public.carts c
      join public.cart_items ci on ci.cart_id = c.id
      where c.tenant_id = $1
        and c.status = 'open'
        and $2::text is null
        and $7::integer is null
        and ($9::boolean is null or $9 = false)
        and ($3::text is null or c.origin = $3)
        and ($4::uuid is null or c.contact_id = $4)
        and ($8::uuid[] is null or c.contact_id = any ($8))
        and ($5::timestamptz is null or c.created_at >= $5)
        and ($6::timestamptz is null or c.created_at < $6)
      group by c.id, c.shipping
    )
    select jsonb_build_object(
      'count', t.cnt,
      'total', t.total,
      'currency', coalesce((select currency from confirmed limit 1), 'COP'),
      'paid', t.paid,
      'pending', t.pending,
      'invoiced_count', t.invoiced_cnt,
      'invoiced_total', t.invoiced_total,
      'by_method', coalesce((select jsonb_object_agg(method, amount) from by_method), '{}'::jsonb),
      'open_carts_count', (select count(*) from open_carts),
      'open_carts_total', (select coalesce(sum(total), 0) from open_carts)
    )
    from totals t
  $sql$
  into result
  using p_tenant_id, p_status, p_channel, p_contact_id, p_date_from, p_date_to, p_search_number, p_search_contact_ids, p_has_invoice;

  return result;
end;
$function$;
