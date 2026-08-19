-- Marcas ganan descripción, mismo campo que ya existe en product_categories
-- -- pedido explícito del usuario para que la tabla de Marcas se vea más
-- completa/estética, no solo nombre+logo+estado.
alter table public.brands add column description text;
