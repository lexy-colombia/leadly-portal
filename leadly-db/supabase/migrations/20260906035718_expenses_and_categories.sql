-- Módulo de Gastos, parte 1: catálogo de categorías + header de gasto.
-- Pedido explícito del usuario: registrar gastos, asociarlos a un proveedor
-- (se reutiliza `suppliers`, no hay entidad nueva de proveedor) y
-- categorizarlos. Mismo patrón que product_categories/suppliers/products
-- (20260815010002_core_catalog.sql): tenant-scoped, soft-delete, RLS con
-- las 4 policies estándar.
--
-- Motivación real, no solo la feature en sí: este módulo también recibe la
-- migración histórica de gastos de Fudo (POS anterior) del tenant "Barriles
-- de la sexta" -- de ahí external_source/external_id en `expenses` (permite
-- un `on conflict` idempotente si el script de import se corre más de una
-- vez) y por qué expense_categories se puebla importando tal cual el
-- nombre que trae Fudo (expenseCategory.name), sin una lista fija definida
-- de antemano.

create table public.expense_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  description text,
  color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

create index expense_categories_tenant_id_idx on public.expense_categories(tenant_id);
create unique index expense_categories_tenant_name_unique on public.expense_categories(tenant_id, lower(name))
  where deleted_at is null;

create trigger expense_categories_set_updated_at
  before update on public.expense_categories
  for each row execute function public.set_updated_at();

alter table public.expense_categories enable row level security;

create policy expense_categories_select on public.expense_categories
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy expense_categories_insert on public.expense_categories
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy expense_categories_update on public.expense_categories
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy expense_categories_delete on public.expense_categories
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.expense_categories from anon;

-- Header de gasto. `amount` es el total real de la compra/factura -- las
-- líneas de entrada de inventario (siguiente migración) no pueden sumar
-- más que esto, se valida en la función add_expense_inventory_entry, no acá
-- (es una invariante entre tablas, no expresable en un check constraint
-- simple de una sola fila).
--
-- payment_method queda como texto libre a propósito (no un catálogo nuevo)
-- -- el pedido del usuario no lo pidió como catálogo administrable, y Fudo
-- solo trae un nombre de método de pago por gasto.
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  supplier_id uuid references public.suppliers(id) on delete set null,
  category_id uuid references public.expense_categories(id) on delete set null,
  amount numeric not null check (amount >= 0),
  currency text not null default 'COP',
  description text,
  payment_method text,
  status text not null default 'pendiente' check (status in ('pendiente', 'pagado', 'anulado')),
  expense_date date not null default current_date,
  due_date date,
  payment_date date,
  -- Idempotencia para importaciones puntuales (Fudo hoy, posiblemente otras
  -- después) -- nulas para un gasto creado a mano desde la app, que es el
  -- camino normal de cara al tenant.
  external_source text,
  external_id text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

create index expenses_tenant_id_idx on public.expenses(tenant_id);
create index expenses_supplier_id_idx on public.expenses(supplier_id);
create index expenses_category_id_idx on public.expenses(category_id);
create index expenses_status_idx on public.expenses(status);
create unique index expenses_tenant_external_unique on public.expenses(tenant_id, external_source, external_id)
  where external_source is not null and external_id is not null;

create trigger expenses_set_updated_at
  before update on public.expenses
  for each row execute function public.set_updated_at();

alter table public.expenses enable row level security;

create policy expenses_select on public.expenses
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy expenses_insert on public.expenses
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy expenses_update on public.expenses
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy expenses_delete on public.expenses
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.expenses from anon;

-- Habilita 'expenses' en el catálogo de módulos togglables por tenant --
-- lista vigente confirmada contra 20260904160000_remove_einvoicing_module.sql
-- (la última migración que tocó este constraint), no la lista vieja de
-- agosto. Deshabilitado por defecto (tabla presence-based, sin backfill) --
-- el superadmin lo prende manualmente para "Barriles de la sexta" cuando el
-- módulo esté listo para probarse.
alter table public.tenant_enabled_modules drop constraint tenant_enabled_modules_module_key_check;
alter table public.tenant_enabled_modules add constraint tenant_enabled_modules_module_key_check check (module_key in (
  'dashboard', 'conversations', 'contacts', 'pipeline', 'products', 'sales',
  'tasks', 'calendar', 'campaigns', 'reports', 'automations', 'aiAgents',
  'billing', 'integrations', 'inventory', 'settings', 'credit', 'dispatches', 'returns',
  'pos', 'expenses'
));
