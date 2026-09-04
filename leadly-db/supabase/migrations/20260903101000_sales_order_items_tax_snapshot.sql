-- Snapshot de impuesto por línea de venta, mismo patrón que product_name/sku
-- en esta misma tabla: una foto del impuesto al momento de la venta, no un
-- valor que cambie si después se edita el producto.
--
-- Sin backfill de filas existentes -- ventas ya confirmadas no se les
-- inventa un desglose retroactivo que nunca se cobró así. Solo los items
-- creados después de que el código de whatsapp-ai-tools/storefront empiece
-- a poblar estas columnas tendrán valores reales.
alter table public.sales_order_items
  add column tax_type_code text references public.tax_types(code),
  add column tax_rate numeric not null default 0,
  add column tax_amount numeric not null default 0,
  add column taxable_base numeric not null default 0;

comment on column public.sales_order_items.tax_amount is 'Impuesto extraído del precio (los precios ya incluyen impuesto) -- tax_amount = subtotal - subtotal/(1+tax_rate/100). sales_orders.total NO cambia de fórmula por esto, sigue siendo = subtotal.';
