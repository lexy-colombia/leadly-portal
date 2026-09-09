-- Flag denormalizado en sales_orders para saber, sin joinear contra
-- sales_invoices en cada carga de la lista, qué pedidos ya tienen una
-- factura DIAN real -- pedido explícito del usuario: quiere filtrar
-- "Órdenes" por facturadas/no facturadas y ver el total facturado, y un
-- tenant real ya tiene 20k+ pedidos (ver list-sales-orders), así que ese
-- filtro tiene que poder indexarse en vez de calcularse por fila en cada
-- request.
--
-- `has_invoice = true` significa "la DIAN ya aceptó/recibió esta factura de
-- verdad" -- mismo criterio exacto que ya usa isRemision en
-- posReceipt.ts/sales-invoice-pdf (status 'sent'/'accepted' + cufe +
-- invoice_number reales, nunca 'pending'/'blocked_missing_buyer_data'/
-- 'rejected'/'error'). Nunca se pone en false de nuevo -- no existe ningún
-- flujo de "anular" una factura ya aceptada en este esquema (sales_invoices
-- es append-only, un rechazo se corrige con un intento NUEVO, nunca
-- editando el que ya se aceptó).

alter table public.sales_orders add column has_invoice boolean not null default false;

-- Parcial: solo indexa las filas que de verdad importan para el filtro
-- ("facturadas"), que van a ser una fracción chica del total de pedidos.
create index sales_orders_has_invoice_idx on public.sales_orders(tenant_id) where has_invoice;

-- Backfill: la columna nace hoy pero facturas ya aceptadas existen desde
-- el 2026-09-03. Un pedido puede tener varios intentos de factura (retry
-- tras un rechazo) -- solo el vigente (attempt_number más alto) decide.
with latest_invoice as (
  select distinct on (order_id) order_id, status, cufe, invoice_number
  from public.sales_invoices
  order by order_id, attempt_number desc
)
update public.sales_orders o
set has_invoice = true
from latest_invoice li
where li.order_id = o.id
  and li.status in ('sent', 'accepted')
  and li.cufe is not null
  and li.invoice_number is not null;

-- get_sales_orders_summary gana el filtro (p_has_invoice, tri-state: null =
-- sin filtrar) y dos campos nuevos en el resumen (invoiced_count/
-- invoiced_total) -- mismo patrón de CTEs que ya tenía, solo se agrega
-- has_invoice a confirmed/per_order para poder agregarlo en totals.
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
        and ($9::boolean is null or o.has_invoice = $9)
    ),
    confirmed as (
      select id, total, currency, pos_point_id, has_invoice from base where status = 'confirmada'
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
        coalesce(sum(pending), 0) as pending,
        count(*) filter (where has_invoice) as invoiced_cnt,
        coalesce(sum(total) filter (where has_invoice), 0) as invoiced_total
      from per_order
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
      'top_tables', coalesce((select jsonb_agg(jsonb_build_object('table', pos_point_name, 'count', cnt, 'total', total)) from tables), '[]'::jsonb)
    )
    from totals t
  $sql$
  into result
  using p_tenant_id, p_status, p_channel, p_contact_id, p_date_from, p_date_to, p_search_number, p_search_contact_ids, p_has_invoice;

  return result;
end;
$$;
