-- SOLO LECTURA. Exporta facturas/notas crédito ACEPTADAS como fixtures para el
-- harness de paridad (S0). Pegar en el SQL editor de Supabase (o psql) y guardar
-- el resultado en progress/fixtures_private/<tenant>.json  (carpeta git-ignorada:
-- contiene PII del comprador).  Reemplazar :tenant_id.
--
-- NO exporta clave técnica ni PIN (viven en Vault). Sin ellos el harness valida
-- estructura, totales, firma y fecha, pero NO puede recalcular el CUFE guardado.
-- Si el titular del tenant los provee legítimamente, agregarlos a mano en
-- "secrets": {"technicalKey": "...", "softwarePin": "..."} dentro del JSON.
--
-- Límites conocidos (el harness los hereda):
--  * profile / mode / pago son los VIGENTES hoy, no los del momento de emisión.
--  * La clave técnica de producción sale de GetNumberingRange (por rango); la
--    manual del tenant solo es respaldo -> aunque se tenga la manual, el CUFE
--    guardado puede haberse calculado con la de la DIAN (ver dian_response.technicalKey.source).

with t as (select :'tenant_id'::uuid as id),
prof as (
  select p.* from public.tenant_dian_profile p, t where p.tenant_id = t.id
),
mode as (
  select (c.mode = 'production') as is_production
  from public.integration_credentials c, t
  where c.tenant_id = t.id and c.provider_key = 'dian_directo' limit 1
)
select jsonb_agg(fx order by (fx->>'issuedAtIso')) as fixtures
from (
  select jsonb_build_object(
    'kind', 'invoice',
    'label', 'inv-' || i.invoice_prefix || i.invoice_number,
    'isProduction', (select is_production from mode),
    'issuedAtIso', to_char(i.issue_date at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'invoicePrefix', i.invoice_prefix,
    'invoiceNumber', i.invoice_number,
    'currency', i.currency,
    'buyer', i.buyer_snapshot,
    'seller', i.seller_snapshot,
    'items', (
      select jsonb_agg(jsonb_build_object(
        'description', it.product_name, 'sku', it.sku, 'quantity', it.quantity,
        'unit_price', it.unit_price, 'subtotal', it.subtotal, 'tax_type_code', it.tax_type_code,
        'tax_rate', it.tax_rate, 'tax_amount', it.tax_amount, 'taxable_base', it.taxable_base
      ) order by it.display_order)
      from public.sales_invoice_items it where it.invoice_id = i.id),
    'profile', (select jsonb_build_object(
        'software_id', software_id, 'resolution_number', resolution_number, 'resolution_prefix', resolution_prefix,
        'resolution_range_from', resolution_range_from, 'resolution_range_to', resolution_range_to,
        'resolution_valid_from', resolution_valid_from, 'resolution_valid_until', resolution_valid_until) from prof),
    'paymentMethod', (select pm.method from public.sales_order_payments pm
                      where pm.order_id = i.order_id and pm.deleted_at is null
                      order by pm.paid_at desc limit 1),
    'storedCufe', i.cufe,
    'secrets', jsonb_build_object('technicalKey', null, 'softwarePin', null),
    'synthetic', false
  ) as fx
  from public.sales_invoices i, t
  where i.tenant_id = t.id and i.status = 'accepted' and i.invoice_number is not null
  union all
  select jsonb_build_object(
    'kind', 'credit_note',
    'label', 'nc-' || n.credit_note_prefix || n.credit_note_number,
    'isProduction', (select is_production from mode),
    'issuedAtIso', to_char(n.issue_date at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'creditNotePrefix', n.credit_note_prefix,
    'creditNoteNumber', n.credit_note_number,
    'currency', n.currency,
    'buyer', n.buyer_snapshot,
    'seller', n.seller_snapshot,
    'reasonCode', n.reason_code,
    'reasonDescription', n.reason_description,
    'tax', jsonb_build_object('code', n.tax_type_code, 'rate', n.tax_rate, 'subtotal', n.subtotal, 'taxTotal', n.tax_total, 'total', n.total),
    -- issueDateIso tal cual lo entrega PostgREST (timestamptz con +00:00): el
    -- orquestador hace slice(0,10) de ESE string.
    'referencedInvoice', jsonb_build_object('prefix', i.invoice_prefix, 'number', i.invoice_number, 'cufe', i.cufe,
                                            'issueDateIso', to_char(i.issue_date at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"+00:00"')),
    'paymentMethod', (select pm.method from public.sales_order_payments pm
                      where pm.order_id = i.order_id and pm.deleted_at is null
                      order by pm.paid_at desc limit 1),
    'profile', (select jsonb_build_object('software_id', software_id) from prof),
    'storedCude', n.cude,
    'secrets', jsonb_build_object('technicalKey', null, 'softwarePin', null),
    'synthetic', false
  )
  from public.sales_credit_notes n
  join public.sales_invoices i on i.id = n.invoice_id, t
  where n.tenant_id = t.id and n.status = 'accepted' and n.credit_note_number is not null
) q;
