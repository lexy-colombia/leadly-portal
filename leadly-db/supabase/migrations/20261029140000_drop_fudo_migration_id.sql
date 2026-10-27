-- Retira la columna temporal fudo_migration_id (id externo de la migración de
-- Fudo). Los pedidos se conservan; solo se borra la columna. Irreversible.
do $$
declare
  v_hit text;
begin
  select string_agg(p.proname, ', ') into v_hit
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind in ('f', 'p')
    and case when p.prokind in ('f', 'p') then pg_get_functiondef(p.oid) end ilike '%fudo_migration_id%';
  if v_hit is not null then
    raise exception 'fudo_migration_id sigue referenciada por funciones de public: %', v_hit;
  end if;

  select string_agg(c.relname, ', ') into v_hit
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('v', 'm')
    and pg_get_viewdef(c.oid) ilike '%fudo_migration_id%';
  if v_hit is not null then
    raise exception 'fudo_migration_id sigue referenciada por vistas de public: %', v_hit;
  end if;
end $$;

drop index if exists public.sales_orders_fudo_migration_id_idx;
drop index if exists public.sales_orders_tenant_fudo_migration_id_uidx;
drop index if exists public.sales_order_items_tenant_fudo_migration_id_uidx;

alter table public.sales_orders drop column if exists fudo_migration_id;
alter table public.sales_order_items drop column if exists fudo_migration_id;
