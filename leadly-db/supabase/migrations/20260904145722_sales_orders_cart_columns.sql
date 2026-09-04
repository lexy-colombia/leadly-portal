-- Todo pedido nuevo de acá en adelante nace de un carrito (cart_id
-- siempre presente); los pedidos históricos quedan con cart_id null, sin
-- backfill -- no había ningún carrito real detrás de ellos.
alter table public.sales_orders add column cart_id uuid references public.carts(id);
alter table public.sales_orders add column pos_point_id uuid references public.pos_points(id) on delete set null;
alter table public.sales_orders add column label text;

create index sales_orders_pos_point_id_idx on public.sales_orders(pos_point_id) where pos_point_id is not null;
create index sales_orders_cart_id_idx on public.sales_orders(cart_id) where cart_id is not null;

-- Ahora que sales_orders existe con su PK íntegra, se completa la FK que
-- se dejó sin tipar en la migración de carts (converted_order_id).
alter table public.carts add constraint carts_converted_order_id_fkey
  foreign key (converted_order_id) references public.sales_orders(id) on delete set null;
