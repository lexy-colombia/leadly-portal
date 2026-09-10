-- Reparación de datos: la limpieza de facturas/notas crédito de prueba
-- hecha antes en esta sesión ("elimina las facturas y notas credito
-- emitidas hoy que ninguna de esas es real") borró las filas de
-- sales_invoices de esos pedidos, pero apply_sales_order_confirmed_effects()
-- (la que reserva la fila "pending" de sales_invoices) solo corre UNA VEZ,
-- en la transición cotizacion -> confirmada -- no se puede volver a
-- disparar sin repetir también sus otros efectos (mover la oportunidad a
-- Ganado, el trigger de stock de confirmación), así que esos pedidos
-- quedaron sin ninguna fila de sales_invoices y la tarjeta de facturación
-- del detalle del pedido dejó de aparecer ("no me sale para facturar").
--
-- Alcance deliberadamente acotado -- NO es un backfill general para toda
-- orden confirmada sin factura (hay ~28k pedidos históricos de la
-- migración de Fudo de este mismo tenant que jamás debieron facturarse,
-- ver fudo_migration_id): solo pedidos con fudo_migration_id null (creados
-- de verdad desde la app) del único tenant con dian_directo activo hoy que
-- quedaron sin ninguna fila de sales_invoices pese a estar confirmados.
--
-- Replica exactamente la lógica de apply_sales_order_confirmed_effects()
-- (20260903180000_sales_order_confirm_triggers.sql) para reconstruir la
-- fila que debió quedar reservada, sin tocar sales_orders.status ni volver
-- a disparar ningún trigger de confirmación.
with target_orders as (
  select o.id, o.tenant_id, o.contact_id, o.billing_address_id, o.subtotal, o.tax_total, o.total, o.currency
  from public.sales_orders o
  join public.integration_credentials ic
    on ic.tenant_id = o.tenant_id and ic.provider_key = 'dian_directo' and ic.is_active = true and ic.deleted_at is null
  where o.status = 'confirmada'
    and o.deleted_at is null
    and o.fudo_migration_id is null
    and not exists (select 1 from public.sales_invoices si where si.order_id = o.id)
),
client_data as (
  select t.id as order_id, c.id as client_id, c.full_name, c.email, c.phone, c.document_number,
         c.dian_document_type_code, c.applies_withholding
  from target_orders t
  left join public.clients c on c.id = t.contact_id
),
address_data as (
  select t.id as order_id, a.line1, a.line2, a.city, a.state_province, a.country, a.tax_id
  from target_orders t
  left join public.contact_addresses a on a.id = t.billing_address_id
),
tenant_data as (
  select t.id as order_id, tn.legal_name, tn.document_type, tn.document_number, tn.country, tn.state_province, tn.billing_address
  from target_orders t
  left join public.tenants tn on tn.id = t.tenant_id
),
profile_data as (
  select t.id as order_id, p.fiscal_regime, p.is_self_withholding_agent, p.city, p.resolution_number, p.resolution_prefix,
         p.resolution_range_from, p.resolution_range_to, p.resolution_valid_from, p.resolution_valid_until, p.software_id
  from target_orders t
  left join public.tenant_dian_profile p on p.tenant_id = t.tenant_id
),
missing as (
  select t.id as order_id,
    array_remove(array[
      case when cd.dian_document_type_code is null then 'tipo de documento del cliente' end,
      case when cd.document_number is null then 'número de documento del cliente' end
    ], null) as missing_fields
  from target_orders t
  join client_data cd on cd.order_id = t.id
),
inserted as (
  insert into public.sales_invoices (tenant_id, order_id, status, status_detail, subtotal, tax_total, total, currency, buyer_snapshot, seller_snapshot)
  select
    t.tenant_id, t.id,
    case when array_length(m.missing_fields, 1) > 0 then 'blocked_missing_buyer_data' else 'pending' end,
    case when array_length(m.missing_fields, 1) > 0 then 'Falta: ' || array_to_string(m.missing_fields, ', ') else null end,
    t.subtotal, t.tax_total, t.total, t.currency,
    jsonb_build_object(
      'client_id', cd.client_id,
      'document_type_code', cd.dian_document_type_code,
      'document_number', cd.document_number,
      'full_name', cd.full_name,
      'email', cd.email,
      'phone', cd.phone,
      'applies_withholding', coalesce(cd.applies_withholding, false),
      'address', case when ad.line1 is null then null else jsonb_build_object(
        'line1', ad.line1, 'line2', ad.line2, 'city', ad.city,
        'state_province', ad.state_province, 'country', ad.country, 'tax_id', ad.tax_id
      ) end
    ),
    jsonb_build_object(
      'tenant_id', t.tenant_id,
      'legal_name', td.legal_name,
      'document_type', td.document_type,
      'document_number', td.document_number,
      'fiscal_regime', pd.fiscal_regime,
      'is_self_withholding_agent', coalesce(pd.is_self_withholding_agent, false),
      'city', pd.city,
      'billing_address', td.billing_address,
      'country', td.country,
      'state_province', td.state_province,
      'resolution', case when pd.resolution_number is null and pd.resolution_prefix is null then null else jsonb_build_object(
        'number', pd.resolution_number, 'prefix', pd.resolution_prefix,
        'range_from', pd.resolution_range_from, 'range_to', pd.resolution_range_to,
        'valid_from', pd.resolution_valid_from, 'valid_until', pd.resolution_valid_until
      ) end,
      'software_id', pd.software_id
    )
  from target_orders t
  join client_data cd on cd.order_id = t.id
  left join address_data ad on ad.order_id = t.id
  join tenant_data td on td.order_id = t.id
  join profile_data pd on pd.order_id = t.id
  join missing m on m.order_id = t.id
  returning id, order_id, tenant_id
)
insert into public.sales_invoice_items (tenant_id, invoice_id, order_item_id, product_name, sku, quantity, unit_price, subtotal, tax_type_code, tax_rate, tax_amount, taxable_base, display_order)
select i.tenant_id, i.id, soi.id, soi.product_name, soi.sku, soi.quantity, soi.unit_price, soi.subtotal,
       soi.tax_type_code, soi.tax_rate, soi.tax_amount, soi.taxable_base, soi.display_order
from inserted i
join public.sales_order_items soi on soi.order_id = i.order_id
order by soi.display_order;
