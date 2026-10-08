-- Campos personalizados, parte 1: definiciones por tenant.
-- Patrón: expense_categories (20260906035718) para tabla tenant-scoped con
-- soft-delete + set_updated_at; escritura admin-only como tenant_roles
-- (20260829120000: is_tenant_admin()). El valor de cada campo vive en una
-- columna jsonb de la entidad (ver 20261006120100 para clients).
-- entity_type 'product' queda permitido por el CHECK pero NO se agrega
-- products.custom_fields todavía (decisión del plan).

create table public.custom_field_definitions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  entity_type text not null check (entity_type in ('client', 'product')),
  name text not null check (length(btrim(name)) between 1 and 100),
  field_type text not null check (field_type in ('text', 'integer', 'decimal', 'boolean', 'date', 'select')),
  options jsonb,
  visible_to_ai boolean not null default false,
  display_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null,
  -- select: arreglo no vacío; cualquier otro tipo: sin opciones.
  constraint custom_field_definitions_options_check check (
    (field_type = 'select' and options is not null and jsonb_typeof(options) = 'array' and jsonb_array_length(options) > 0)
    or (field_type <> 'select' and options is null)
  )
);

create index custom_field_definitions_tenant_id_idx on public.custom_field_definitions(tenant_id);
create unique index custom_field_definitions_tenant_name_unique
  on public.custom_field_definitions(tenant_id, entity_type, lower(name))
  where deleted_at is null;

create trigger custom_field_definitions_set_updated_at
  before update on public.custom_field_definitions
  for each row execute function public.set_updated_at();

-- Guardas de integridad: tipo/entidad/tenant inmutables (cambiar el tipo dejaría
-- valores viejos incoherentes) y opciones de un select = strings no vacíos únicos.
create or replace function public.guard_custom_field_definition()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  bad_count int;
begin
  if tg_op = 'UPDATE' then
    if new.field_type is distinct from old.field_type then
      raise exception 'El tipo de un campo personalizado no se puede cambiar. Crea un campo nuevo con el tipo que necesitas.'
        using errcode = '23514';
    end if;
    if new.entity_type is distinct from old.entity_type then
      raise exception 'La entidad de un campo personalizado no se puede cambiar.' using errcode = '23514';
    end if;
    if new.tenant_id is distinct from old.tenant_id then
      raise exception 'El tenant de un campo personalizado no se puede cambiar.' using errcode = '23514';
    end if;
  end if;

  if new.field_type = 'select' and jsonb_typeof(new.options) = 'array' then
    select count(*) into bad_count
    from jsonb_array_elements(new.options) e
    where jsonb_typeof(e) <> 'string' or btrim(e #>> '{}') = '' or length(e #>> '{}') > 200;
    if bad_count > 0 then
      raise exception 'Las opciones de la lista deben ser textos no vacíos de máximo 200 caracteres.' using errcode = '23514';
    end if;
    if (select count(distinct e #>> '{}') from jsonb_array_elements(new.options) e) <> jsonb_array_length(new.options) then
      raise exception 'Las opciones de la lista no pueden repetirse.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_custom_field_definition() from public, anon, authenticated;

create trigger custom_field_definitions_guard
  before insert or update on public.custom_field_definitions
  for each row execute function public.guard_custom_field_definition();

alter table public.custom_field_definitions enable row level security;

-- Cualquier usuario del tenant lee las definiciones (necesita pintar la ficha).
create policy custom_field_definitions_select on public.custom_field_definitions
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy custom_field_definitions_insert on public.custom_field_definitions
  for insert with check (
    public.is_superadmin() or (tenant_id = public.auth_active_tenant_id() and public.is_tenant_admin())
  );
create policy custom_field_definitions_update on public.custom_field_definitions
  for update using (
    public.is_superadmin() or (tenant_id = public.auth_active_tenant_id() and public.is_tenant_admin())
  ) with check (
    public.is_superadmin() or (tenant_id = public.auth_active_tenant_id() and public.is_tenant_admin())
  );
create policy custom_field_definitions_delete on public.custom_field_definitions
  for delete using (
    public.is_superadmin() or (tenant_id = public.auth_active_tenant_id() and public.is_tenant_admin())
  );

revoke all on public.custom_field_definitions from anon;
