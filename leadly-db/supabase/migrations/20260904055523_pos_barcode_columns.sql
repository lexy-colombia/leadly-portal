-- Módulo POS -- escanear un producto con lector de código de barras. Sin
-- esto no había forma de resolver un producto/variante a partir de un
-- código escaneado. Mismo patrón que sku/slug: índice único parcial por
-- tenant (nullable, un producto sin código no participa del índice).
alter table public.products add column barcode text;
alter table public.product_variants add column barcode text;

create unique index products_tenant_barcode_unique on public.products(tenant_id, barcode)
  where barcode is not null and deleted_at is null;
create unique index product_variants_tenant_barcode_unique on public.product_variants(tenant_id, barcode)
  where barcode is not null and deleted_at is null;
