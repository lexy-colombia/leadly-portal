-- Índice para el listado de Órdenes (list-sales-orders):
--   where tenant_id = ? and deleted_at is null order by created_at desc limit N
-- Sin él, Postgres hacía Seq Scan de todos los pedidos del tenant (28.477 filas
-- en el tenant más grande, ~467 ms en frío) más un top-N heapsort. El índice
-- parcial sirve el orden directamente y solo cubre filas vivas.
-- Sin CONCURRENTLY: las migraciones corren en transacción y la tabla es chica.
create index if not exists sales_orders_tenant_created_at_idx
  on public.sales_orders (tenant_id, created_at desc)
  where deleted_at is null;
