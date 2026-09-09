-- Ubicación real en celda (fila, columna) de cada punto de venta -- a
-- diferencia de display_order (una lista lineal que se auto-acomoda en una
-- grilla pareja), acá el usuario puede dejar huecos y columnas de distinto
-- largo: cada punto vive en una celda propia, arrastrable a cualquier otra
-- (ver PosPointsGrid.tsx). 5 columnas fijas, sin límite real de filas.
alter table public.pos_points add column grid_row integer not null default 0;
alter table public.pos_points add column grid_col integer not null default 0;

-- Backfill: arranca en el mismo orden que ya tenían por display_order,
-- acomodados fila por fila de a 5 columnas -- mismo resultado visual que la
-- grilla automática que se usaba hasta ahora, pero ya editable en celdas
-- sueltas de acá en más.
with ranked as (
  select id, row_number() over (partition by tenant_id order by display_order, created_at) - 1 as rn
  from public.pos_points
  where deleted_at is null
)
update public.pos_points p
set grid_row = ranked.rn / 5, grid_col = ranked.rn % 5
from ranked
where p.id = ranked.id;
