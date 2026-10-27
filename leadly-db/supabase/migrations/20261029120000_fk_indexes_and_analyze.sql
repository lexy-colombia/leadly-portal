-- Índices para claves foráneas sin índice (auditoría 2026-10-26). Solo las
-- columnas que se usan para unir/filtrar; created_by/deleted_by y los FK a
-- catálogos pequeños se descartan a propósito. Sin CONCURRENTLY: la migración
-- corre en transacción y las tablas son chicas (la mayor, ~3,7k filas).
create index if not exists idx_cart_items_product_id on public.cart_items (product_id);
create index if not exists idx_cart_items_variant_id on public.cart_items (variant_id);
create index if not exists idx_cart_items_warehouse_id on public.cart_items (warehouse_id);

create index if not exists idx_carts_billing_address_id on public.carts (billing_address_id);
create index if not exists idx_carts_contact_id on public.carts (contact_id);
create index if not exists idx_carts_converted_order_id on public.carts (converted_order_id);
create index if not exists idx_carts_opportunity_id on public.carts (opportunity_id);
create index if not exists idx_carts_pos_point_id on public.carts (pos_point_id);
create index if not exists idx_carts_shipping_address_id on public.carts (shipping_address_id);

create index if not exists idx_credit_charges_sales_order_id on public.credit_charges (sales_order_id);
create index if not exists idx_store_credit_redemptions_sales_order_id on public.store_credit_redemptions (sales_order_id);
create index if not exists idx_sales_invoice_items_order_item_id on public.sales_invoice_items (order_item_id);

analyze public.sales_orders;
analyze public.sales_order_items;
analyze public.sales_order_payments;
analyze public.carts;
analyze public.cart_items;
analyze public.credit_charges;
