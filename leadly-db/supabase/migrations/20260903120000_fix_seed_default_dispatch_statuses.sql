-- Bug real: seed_default_dispatch_statuses() (trigger after insert on tenants,
-- crea los 5 estados de despacho por defecto de cada tenant nuevo) seguía
-- insertando la columna stock_effect, eliminada de dispatch_statuses en
-- 20260825143925_remove_reserve_departure_and_dispatch_stock_effect.sql --
-- la función nunca se actualizó en esa migración. Quedó dormido porque no
-- se creó ningún tenant nuevo desde entonces; encontrado recién al intentar
-- registrar un cliente nuevo real, que fallaba con
-- "column stock_effect of relation dispatch_statuses does not exist".
create or replace function public.seed_default_dispatch_statuses()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.dispatch_statuses (tenant_id, name, color, display_order, is_terminal) values
    (new.id, 'Preparando', '#F59E0B', 0, false),
    (new.id, 'Despachado', '#3B82F6', 1, false),
    (new.id, 'En camino', '#6366F1', 2, false),
    (new.id, 'Entregado', '#10B981', 3, true),
    (new.id, 'Devuelto', '#EF4444', 4, true);
  return new;
end;
$$;
