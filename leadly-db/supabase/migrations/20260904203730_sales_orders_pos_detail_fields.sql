-- Campos del detalle de venta de Fudo que hasta ahora no se guardaban en
-- sales_orders (mesa, sala, personas, mesero, tipo de venta, medio de pago
-- como texto propio) -- pedido explícito del usuario para que el detalle de
-- la orden en Leadly muestre la misma información que Fudo, y para poder
-- calcular qué mesa vende más en el punto de venta.
alter table public.sales_orders add column pos_table text;
alter table public.sales_orders add column pos_room text;
alter table public.sales_orders add column party_size integer;
alter table public.sales_orders add column server_name text;
alter table public.sales_orders add column sale_type text;
alter table public.sales_orders add column payment_method_label text;
