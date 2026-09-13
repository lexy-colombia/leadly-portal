-- Consecutivo por comercio para los egresos (EGR-1, EGR-2, ...).
--
-- Pedido explícito del usuario (2026-09-13): el comprobante de egreso se va a
-- imprimir (tirilla y PDF), y un comprobante sin número no se puede
-- referenciar después: dos gastos del mismo día al mismo proveedor serían
-- indistinguibles en el papel.
--
-- Mismo mecanismo que sales_orders.number: una secuencia POR TENANT resuelta
-- en un trigger BEFORE INSERT (max + 1), no una secuencia global de Postgres
-- -- cada comercio tiene que ver su propia numeración empezando en 1, y una
-- secuencia global le mostraría saltos por los gastos de otros tenants.
--
-- Backfill de lo ya existente (6.000+ gastos importados de Fudo incluidos)
-- ordenado por fecha del gasto y, a igualdad, por fecha de creación: el
-- número queda en el mismo orden cronológico en que ocurrieron. Se numeran
-- también los eliminados, para que el índice único no choque si alguno se
-- restaura.

alter table public.expenses add column if not exists number integer;

with numbered as (
  select id, row_number() over (partition by tenant_id order by expense_date, created_at, id) as rn
  from public.expenses
)
update public.expenses e
   set number = n.rn
  from numbered n
 where n.id = e.id and e.number is null;

create or replace function public.set_expense_number()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.number is null then
    select coalesce(max(number), 0) + 1 into new.number
      from public.expenses where tenant_id = new.tenant_id;
  end if;
  return new;
end;
$$;

revoke execute on function public.set_expense_number() from public, anon, authenticated;

drop trigger if exists trg_expenses_set_number on public.expenses;
create trigger trg_expenses_set_number
  before insert on public.expenses
  for each row execute function public.set_expense_number();

alter table public.expenses alter column number set not null;

create unique index if not exists expenses_tenant_number_key on public.expenses (tenant_id, number);
