-- Dos cambios pedidos juntos por el usuario (2026-08-17):
-- 1) product_categories gana parent_category_id -- árbol de categorías con
--    niveles, en vez del catálogo plano actual.
-- 2) products deja de tener category_id (1:1) -- pasa a product_category_links,
--    tabla puente muchos-a-muchos (un producto puede estar en varias
--    categorías). Mismo criterio ya documentado en CLAUDE.md para tablas
--    puente sin identidad de negocio propia (ej. conversation_tag_assignments):
--    sin soft-delete, "quitar" es un DELETE real.

alter table public.product_categories
  add column parent_category_id uuid references public.product_categories(id) on delete set null,
  add constraint product_categories_parent_not_self check (parent_category_id is null or parent_category_id <> id);

create index product_categories_parent_category_id_idx on public.product_categories(parent_category_id);

create table public.product_category_links (
  product_id uuid not null references public.products(id) on delete cascade,
  category_id uuid not null references public.product_categories(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (product_id, category_id)
);

create index product_category_links_category_id_idx on public.product_category_links(category_id);
create index product_category_links_tenant_id_idx on public.product_category_links(tenant_id);

alter table public.product_category_links enable row level security;

create policy product_category_links_select on public.product_category_links
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy product_category_links_insert on public.product_category_links
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy product_category_links_delete on public.product_category_links
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.product_category_links from anon;

-- Backfill: cada producto con category_id ya seteado gana su única fila
-- equivalente en la tabla puente antes de que la columna vieja se borre.
insert into public.product_category_links (product_id, category_id, tenant_id)
select id, category_id, tenant_id from public.products where category_id is not null;

drop index if exists public.products_category_id_idx;
alter table public.products drop column category_id;
