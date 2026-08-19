-- Decisión explícita del usuario (2026-08-19): el color por categoría no se
-- usa/no se quiere, se saca de la base y de todo el código (chips, filtros,
-- drawer de categoría) -- no era una columna en uso real, solo decoración.
alter table public.product_categories drop column color;
