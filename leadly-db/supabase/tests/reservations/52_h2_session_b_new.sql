-- Sesion B (patron NUEVO): cart_settle_billed_items toma primero el lock del carrito.
begin;
select public.cart_settle_billed_items(t.id('cd'), t.id('td'), (select array_agg(id) from public.cart_items where cart_id = t.id('cd') and product_name = 'pd1'), '[]'::jsonb);
select pg_sleep(2);
commit;
select 'B_RESULT ok';
