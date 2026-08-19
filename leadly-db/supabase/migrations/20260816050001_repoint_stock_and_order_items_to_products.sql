-- Empieza el cutover del catálogo: el frontend va a pasar de leer
-- crm_products a leer products (esquema ERP sin prefijo). Pedido explícito
-- del usuario (2026-08-16) -- "ninguno es un producto real", así que no
-- hace falta migrar datos, solo repuntar las FKs que hoy apuntan a
-- crm_products para que apunten a products.
--
-- crm_products en sí NO se toca (sigue existiendo, intacta, por si hace
-- falta consultarla) -- lo que se repunta es lo que otras tablas nuevas ya
-- construidas (product_stock/stock_movements, Fase 1 Inventario) y una
-- tabla vieja (crm_order_items, el picker de productos de una cotización/
-- venta) referencian.

-- product_stock/stock_movements tenían datos demo del backfill de Fase 1,
-- ligados a ids de crm_products -- se limpian antes de repuntar la FK
-- porque esos ids no existen en products.
truncate table public.stock_movements;
truncate table public.product_stock;

alter table public.product_stock drop constraint product_stock_product_id_fkey;
alter table public.product_stock add constraint product_stock_product_id_fkey
  foreign key (product_id) references public.products(id) on delete cascade;

alter table public.stock_movements drop constraint stock_movements_product_id_fkey;
alter table public.stock_movements add constraint stock_movements_product_id_fkey
  foreign key (product_id) references public.products(id) on delete restrict;

-- crm_order_items.product_id es nullable (ya soporta líneas "sin catálogo"
-- desde el diseño original) -- las filas existentes quedan sin el link vivo
-- a un producto, pero conservan su snapshot (product_name/sku/subtotal),
-- que es lo que de verdad importa para el historial de una orden ya hecha.
update public.crm_order_items set product_id = null where product_id is not null;

alter table public.crm_order_items drop constraint crm_order_items_product_id_fkey;
alter table public.crm_order_items add constraint crm_order_items_product_id_fkey
  foreign key (product_id) references public.products(id) on delete set null;
