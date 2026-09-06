-- Soporte para la Edge Function `list-expenses`: mismo problema real que ya
-- se resolvió para Órdenes (20260904220000_sales_orders_summary_aggregate.sql)
-- -- Gastos ya tiene 6072 filas migradas de Fudo para un solo tenant, y
-- PostgREST corta cualquier select en 1000 filas por request (db.max_rows).
-- ExpensesTab.tsx traía TODO el historial filtrado a la vez y paginaba
-- recién en el navegador -- con más de 1000 filas, el resto quedaba
-- invisible sin ningún error. Se reemplaza por paginación real con offset
-- en la DB (.range(), vía la Edge Function) + este agregado (count/sum) que
-- nunca depende de traer todas las filas a ningún lado.
--
-- No aplica RLS (se llama solo con el service role desde list-expenses,
-- igual que get_sales_orders_summary) -- el filtro por tenant_id es
-- explícito acá adentro. No se expone a authenticated/anon.
create or replace function public.get_expenses_summary(
  p_tenant_id uuid,
  p_supplier_id uuid default null,
  p_category_id uuid default null,
  p_date_from date default null,
  p_date_to date default null
)
returns jsonb
language sql
stable
set search_path = public
as $$
  with base as (
    select e.*
    from public.expenses e
    where e.tenant_id = p_tenant_id
      and e.deleted_at is null
      and (p_supplier_id is null or e.supplier_id = p_supplier_id)
      and (p_category_id is null or e.category_id = p_category_id)
      and (p_date_from is null or e.expense_date >= p_date_from)
      and (p_date_to is null or e.expense_date <= p_date_to)
  )
  select jsonb_build_object(
    'count', (select count(*) from base),
    'total', coalesce((select sum(amount) from base), 0),
    'currency', coalesce((select currency from base limit 1), 'COP')
  );
$$;

revoke all on function public.get_expenses_summary(uuid, uuid, uuid, date, date) from public;
grant execute on function public.get_expenses_summary(uuid, uuid, uuid, date, date) to service_role;
