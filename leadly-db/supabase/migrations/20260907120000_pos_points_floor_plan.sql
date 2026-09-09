-- Plano visual de puntos de venta: posición libre (x,y) por punto, más un
-- interruptor opt-in para que la pantalla operativa del POS (PosOpenTabs)
-- use ese plano en vez de la grilla automática actual. Apagado por default
-- para no cambiarle la pantalla de cobro a ningún tenant sin que lo pida.
alter table public.pos_points add column layout_x numeric not null default 0;
alter table public.pos_points add column layout_y numeric not null default 0;

alter table public.tenants add column pos_floor_plan_enabled boolean not null default false;

-- Backfill: los puntos existentes no tienen ninguna posición real todavía --
-- se les da un arreglo inicial en grilla (4 columnas, mismo orden que
-- display_order) para que el plano no arranque con todos apilados en (0,0).
with ranked as (
  select id, row_number() over (partition by tenant_id order by display_order, created_at) - 1 as rn
  from public.pos_points
  where deleted_at is null
)
update public.pos_points p
set layout_x = (ranked.rn % 4) * 220, layout_y = (ranked.rn / 4) * 170
from ranked
where p.id = ranked.id;
