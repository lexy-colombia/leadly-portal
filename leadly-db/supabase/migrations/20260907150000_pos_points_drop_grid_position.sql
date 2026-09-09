-- Revierte 20260907140000_pos_points_grid_position.sql -- el usuario pidió
-- eliminar toda la lógica de organizar puntos de venta en grilla/plano.
-- pos_points vuelve a depender únicamente de display_order (reorden lineal
-- con las flechas arriba/abajo de Configuración > Puntos de venta), como
-- estaba antes de esta ronda completa de intentos (plano libre con zoom,
-- grilla de reordenar, grilla 2D de celdas).
alter table public.pos_points drop column grid_row;
alter table public.pos_points drop column grid_col;
