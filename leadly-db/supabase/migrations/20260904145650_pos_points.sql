-- Catálogo opcional de puntos de venta del POS (mesas de un restaurante,
-- cajas de un mostrador, o puntos genéricos) para agrupar las cuentas
-- abiertas. Es opcional a propósito: cero puntos configurados es un estado
-- válido y el POS muestra las cuentas en una lista simple.
--
-- `is_active` separa "este punto ya no se usa hoy" (mesa fuera de servicio,
-- caja cerrada) de eliminarlo -- el módulo POS solo lista los activos, el
-- catálogo de Configuración los muestra todos para poder reactivarlos.
-- Eliminar sí es soft-delete, misma convención que el resto del proyecto.
create table if not exists pos_points (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  kind text not null default 'punto' check (kind in ('mesa', 'caja', 'punto')),
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references profiles(id) on delete set null
);

create index if not exists pos_points_tenant_id_idx on pos_points (tenant_id);

drop trigger if exists pos_points_set_updated_at on pos_points;
create trigger pos_points_set_updated_at before update on pos_points
  for each row execute function set_updated_at();

alter table pos_points enable row level security;

drop policy if exists pos_points_select on pos_points;
create policy pos_points_select on pos_points for select
  using (tenant_id = auth_active_tenant_id() or is_superadmin());

drop policy if exists pos_points_insert on pos_points;
create policy pos_points_insert on pos_points for insert
  with check (tenant_id = auth_active_tenant_id() or is_superadmin());

drop policy if exists pos_points_update on pos_points;
create policy pos_points_update on pos_points for update
  using (tenant_id = auth_active_tenant_id() or is_superadmin())
  with check (tenant_id = auth_active_tenant_id() or is_superadmin());

drop policy if exists pos_points_delete on pos_points;
create policy pos_points_delete on pos_points for delete
  using (tenant_id = auth_active_tenant_id() or is_superadmin());
