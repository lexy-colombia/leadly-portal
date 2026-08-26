-- Reemplazado por la tienda pública por tenant (marketplace, ver CLAUDE.md)
-- en vez de convivir con ella -- son arquitecturas distintas (esto asumía
-- una orden y un cliente ya identificados; la tienda arranca sin ninguno de
-- los dos) y forzar una sobre la otra complicaba las dos. Ninguna fila real
-- usó nada de esto (`carrito` nunca se habilitó para ningún asistente), así
-- que no hace falta migración de datos.
delete from ai_assistant_skills where skill_key = 'carrito';
delete from ai_skills where key = 'carrito';
drop table if exists public.sales_order_checkout_links;
