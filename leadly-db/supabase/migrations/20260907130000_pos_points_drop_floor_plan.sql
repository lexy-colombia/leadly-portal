-- Revierte 20260907120000_pos_points_floor_plan.sql -- el usuario probó el
-- plano libre (posición x/y + zoom/pan) y pidió algo distinto: una grilla
-- simple donde arrastrar para reordenar (mismo criterio que el Kanban de
-- Oportunidades), reutilizando display_order que ya existía. Sin necesidad
-- de coordenadas libres ni de un modo aparte para la pantalla operativa.
alter table public.tenants drop column pos_floor_plan_enabled;
alter table public.pos_points drop column layout_x;
alter table public.pos_points drop column layout_y;
