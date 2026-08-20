-- Permite que una línea de cotización/venta apunte a una variante concreta,
-- no solo al producto -- necesario para que OrderItemsEditor pueda vender
-- "Camisa Azul talla M" y no solo "Camisa". No se construye ninguna lógica
-- de reserva/efecto de stock contra ventas en esta migración --
-- sales_orders/sales_order_items hoy no tocan product_stock en absoluto
-- (eso es "Despachos", fase futura, ver core_sales.sql); esta columna solo
-- deja el picker funcionando.
alter table public.sales_order_items
  add column variant_id uuid references public.product_variants(id) on delete set null;

create index sales_order_items_variant_id_idx on public.sales_order_items(variant_id);

-- on delete set null, igual que product_id ya hace en esta tabla:
-- product_name/sku son un snapshot de texto (ver core_sales.sql), así que
-- perder el link vivo a la variante no pierde el historial legible de la
-- orden -- solo deja de poder navegar de vuelta a esa variante concreta si
-- se borra.
