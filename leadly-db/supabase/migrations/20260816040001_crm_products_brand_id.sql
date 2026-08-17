-- Deja asignarle una marca a un producto -- pedido explícito del usuario
-- (2026-08-16), después de dejar claro dos veces que `brands` (esquema ERP
-- sin prefijo) no tenía forma de conectarse a un producto real porque
-- crm_products no tenía columna brand_id.
--
-- Esta es la primera vez en todo el pivote que se altera una tabla crm_*
-- -- hecho a propósito, con permiso explícito, no como parte de la
-- migración de nomenclatura (esa regla sigue en pie para ese esfuerzo
-- puntual). Es un ALTER 100% aditivo y de bajísimo riesgo: columna nueva,
-- nullable, sin default raro, sin tocar ningún trigger/policy existente de
-- crm_products -- cualquier insert/update que no la mencione simplemente
-- la deja en null, igual que category_id/supplier_id cuando se agregaron.

alter table public.crm_products
  add column brand_id uuid references public.brands(id) on delete set null;

create index crm_products_brand_id_idx on public.crm_products(brand_id);
