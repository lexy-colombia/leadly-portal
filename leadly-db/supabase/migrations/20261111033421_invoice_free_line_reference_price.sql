-- Referencia comercial unitaria CON impuesto; nunca modifica el cobro.
-- Sin backfill: el valor comercial de una cortesía debe aportarlo el negocio.
alter table public.products
  add column dian_reference_price numeric(18, 6)
  check (dian_reference_price > 0 and dian_reference_price < 'Infinity'::numeric);
alter table public.sales_invoice_items
  add column reference_unit_price numeric(18, 6)
  check (reference_unit_price > 0 and reference_unit_price < 'Infinity'::numeric);
comment on column public.products.dian_reference_price is
  'Precio comercial unitario con impuesto para DIAN en cortesías con precio de venta cero. No se cobra al comprador.';
comment on column public.sales_invoice_items.reference_unit_price is
  'Snapshot del precio comercial unitario con impuesto, independiente del cobro. FAW03.';
