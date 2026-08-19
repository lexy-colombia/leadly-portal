-- Permite desactivar una categoría sin borrarla ni tocar los productos que
-- ya la tienen enlazada (product_category_links no se toca acá) -- una
-- categoría inactiva simplemente deja de ofrecerse como opción nueva al
-- crear/editar un producto (ver CategoryMultiSelect en ProductDrawer.tsx),
-- mismo patrón ya usado por brands.is_active.
alter table public.product_categories add column is_active boolean not null default true;
