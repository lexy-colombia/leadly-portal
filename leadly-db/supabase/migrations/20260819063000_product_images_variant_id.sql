-- Fotos por variante -- null sigue siendo la foto general del producto (se
-- muestra siempre en el carrusel); con variant_id, es una foto específica
-- de esa combinación (ej. la del color Azul), que ProductDrawer agrupa
-- bajo su variante en vez de mezclarla con las generales.
alter table public.product_images
  add column variant_id uuid references public.product_variants(id) on delete cascade;

create index product_images_variant_id_idx on public.product_images(variant_id);

comment on column public.product_images.variant_id is
  'Null = foto general del producto (se muestra siempre en el carrusel). Set = foto específica de esa variante (ej. la del color Azul) -- ProductDrawer las agrupa bajo su variante en vez de mezclarlas con las generales.';
