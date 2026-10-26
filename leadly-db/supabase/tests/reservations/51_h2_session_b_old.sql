-- Sesion B (patron VIEJO de create-order): borra lineas con un DELETE y recien despues el
-- trigger pide el lock del carrito. El qual lento deja la sentencia abierta con la fila 1 bloqueada.
with d as (
  delete from public.cart_items where cart_id = t.id('cd') and (product_name = 'pd1' or (select pg_sleep(2)) is not null) returning 1
) select 'B_RESULT ' || count(*) from d;
