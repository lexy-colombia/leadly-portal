-- Columna temporal para la migración masiva del histórico de ventas de Fudo
-- (Barriles de la Sexta) -- correlaciona cada sales_orders con el Id numérico
-- original de Fudo para poder resolver sales_order_items.order_id via JOIN
-- en vez de tener que reescribir miles de UUIDs a mano. Se dropea al terminar
-- la migración.
alter table public.sales_orders add column fudo_migration_id integer;
create index sales_orders_fudo_migration_id_idx on public.sales_orders(tenant_id, fudo_migration_id);

create table public._migration_client_map (idx integer primary key, client_id uuid not null);
create table public._migration_product_map (idx integer primary key, product_id uuid not null);
