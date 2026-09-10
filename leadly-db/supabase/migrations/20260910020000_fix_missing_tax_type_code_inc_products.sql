-- Bug de datos real, encontrado probando en vivo la emisión de la orden
-- 7627492d-1243-4a60-833d-47fd5974f43b (pedido explícito del usuario
-- 2026-09-10: "prueba tu mismo con esta orden... ajusta todo hasta que la
-- emision de facturas con la dian funcione"): dos productos del tenant
-- "INVERSIONES GASTRONIMICAS DEL HUILA SAS" (Agua en botella, Menú
-- ejecutivo - pechuga) tienen tax_rate=8 pero tax_type_code NULL, mientras
-- que los otros 191 productos del mismo tenant a esa misma tarifa sí tienen
-- tax_type_code='04' (INC, Impuesto Nacional al Consumo -- la tarifa
-- estándar de restaurantes). Con tax_type_code null, sendInvoiceToDian.ts
-- arma la línea del XML SIN impuesto (line.tax = null): el LineExtensionAmount
-- queda con el monto CON impuesto incluido en vez del neto, y no se genera
-- ningún cac:TaxTotal -- un cálculo fiscal completamente incorrecto, no solo
-- un dato faltante. Ya causó al menos un rechazo real anterior (factura
-- 61840000-8541-4dd3-adff-e1ab89beaec5).
--
-- Se corrige en tres capas -- products (el catálogo, para que las ventas
-- FUTURAS de este producto copien el código correcto), sales_order_items
-- (los pedidos ya tomados con el dato incompleto -- buildOrderSnapshot en
-- queueInvoiceGeneration.ts SIEMPRE relee de acá antes de armar el XML real,
-- así que corregir esto alcanza para que cualquier reintento futuro salga
-- bien) y sales_invoice_items (las facturas YA reservadas con el snapshot
-- viejo, por higiene -- se sobrescriben solas en el próximo envío real vía
-- refreshInvoiceSnapshot, pero no tiene sentido dejarlas con el dato malo
-- mientras tanto). Nunca se tocan facturas ya sent/accepted/rejected con
-- intento fiscal real (son registros de auditoría) -- solo pending/blocked,
-- que todavía no se mandaron.

update public.products
set tax_type_code = '04'
where tenant_id = '9c79437d-1c19-4edc-bc1f-0dc06094823a'
  and tax_type_code is null
  and tax_rate = 8;

update public.sales_order_items soi
set tax_type_code = '04'
from public.sales_orders o
where soi.order_id = o.id
  and o.tenant_id = '9c79437d-1c19-4edc-bc1f-0dc06094823a'
  and soi.tax_type_code is null
  and soi.tax_rate = 8;

update public.sales_invoice_items sii
set tax_type_code = '04'
from public.sales_invoices si
where sii.invoice_id = si.id
  and si.tenant_id = '9c79437d-1c19-4edc-bc1f-0dc06094823a'
  and sii.tax_type_code is null
  and sii.tax_rate = 8
  and si.status in ('pending', 'blocked_missing_buyer_data');
