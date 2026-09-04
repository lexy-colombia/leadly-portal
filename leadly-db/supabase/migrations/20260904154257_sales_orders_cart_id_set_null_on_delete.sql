-- Bug real encontrado en vivo: apenas un carrito generaba un primer cobro
-- parcial (dividir cuenta), la FK sales_orders.cart_id -> carts(id) sin
-- ON DELETE explícito quedaba en NO ACTION -- "Cancelar cuenta" sobre el
-- resto del carrito fallaba porque ya había un pedido real referenciándolo.
-- Un pedido ya confirmado/pagado nunca debe desaparecer solo porque se
-- cancela el resto del carrito -- se pone en null la referencia, no se
-- toca el pedido.
alter table public.sales_orders drop constraint sales_orders_cart_id_fkey;
alter table public.sales_orders add constraint sales_orders_cart_id_fkey
  foreign key (cart_id) references public.carts(id) on delete set null;
