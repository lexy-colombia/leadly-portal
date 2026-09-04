-- sales_channel (agregado en 20260904055556_pos_sales_channel.sql) solo lo
-- escribía pos-checkout: todo lo demás quedaba en null, así que desde
-- Ventas era imposible saber si un pedido lo armó un agente en el portal,
-- la IA por WhatsApp o un cliente en la tienda pública. A partir de esta
-- ronda los cuatro caminos lo setean siempre (create-order -> 'portal'/'pos',
-- whatsapp-ai-tools -> 'whatsapp', storefront -> 'storefront', pos-checkout
-- -> 'pos'). Esto es el backfill de lo que ya existía.
--
-- Las tres reglas van de la más específica a la más general y se aplican en
-- ese orden; ninguna pisa una fila que ya tenga canal:
--   1. La tienda pública firma sus pedidos con esa nota exacta.
--   2. created_by no nulo = lo creó un usuario logueado, o sea el portal
--      (la IA y la tienda corren con service role, sin usuario).
--   3. El resto (sin usuario, sin nota de tienda) solo puede venir de la IA.
update public.sales_orders
   set sales_channel = 'storefront'
 where sales_channel is null
   and notes = 'Pedido creado desde la tienda pública.';

update public.sales_orders
   set sales_channel = 'portal'
 where sales_channel is null
   and created_by is not null;

update public.sales_orders
   set sales_channel = 'whatsapp'
 where sales_channel is null;
