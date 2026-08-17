-- Elimina crm_products, crm_product_categories, crm_suppliers,
-- crm_product_images y todo lo que dependía de ellas -- pedido explícito
-- del usuario (2026-08-16), después de confirmar el impacto real:
--
-- - El frontend ya no las usa desde el cutover del mismo día (Productos.tsx
--   y compañía leen `products`/`product_categories`/`suppliers`/
--   `product_images`).
-- - Rompe a Aurora: `whatsapp-ai-tools` (habilidades catalogo/ventas)
--   sigue consultando crm_products directamente. Asumido explícitamente
--   por el usuario -- no se tocó el Edge Function, pero deja de poder
--   cotizar/vender por WhatsApp hasta que se migre aparte.
-- - Sin esto, el trigger de stock de crm_order_items/crm_orders
--   (adjust_product_stock -> UPDATE crm_products) hubiera empezado a
--   tirar error en el próximo pedido/cambio de estado en Ventas.tsx --
--   se desactiva primero para que esa tabla (crm_orders/crm_order_items,
--   que NO se borra, sigue en uso) no se rompa.

drop trigger trg_crm_orders_status_stock on public.crm_orders;
drop trigger trg_crm_order_items_delete_stock on public.crm_order_items;
drop trigger trg_crm_order_items_insert_stock on public.crm_order_items;

drop function public.apply_order_status_stock_effect();
drop function public.apply_order_item_stock_effect();
drop function public.adjust_product_stock(uuid, integer, integer);

drop table public.crm_product_images;
drop table public.crm_products;
drop table public.crm_product_categories;
drop table public.crm_suppliers;
