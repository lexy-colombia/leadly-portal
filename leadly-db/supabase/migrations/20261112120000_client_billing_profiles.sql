-- F1 / S1.1 — Perfiles de facturación del cliente (client_billing_profiles).
--
-- Un cliente (clients) puede tener varios perfiles fiscales (persona natural,
-- razón social, etc.). El perfil es AUTOSUFICIENTE: lleva documento, nombre
-- legal, correo, régimen y domicilio fiscal en columnas, sin respaldo
-- posterior desde `clients`. Aditiva: no modifica ninguna fila existente.
--
-- Esta migración solo crea el esquema. El backfill desde clients está en
-- 20261112121000; las columnas de pedidos/carritos en 20261112122000.

-- Clave única auxiliar: permite la FK compuesta (tenant, cliente) de los
-- perfiles (aislamiento por esquema). `id` ya es único: es un índice de
-- soporte, no cambia datos. (contact_addresses NO lleva FK compuesta nueva:
-- evitaría ambigüedad de embeds PostgREST; ver trigger en 20261112122000.)
alter table public.clients
  add constraint clients_tenant_id_id_key unique (tenant_id, id);

create table public.client_billing_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  client_id uuid not null,
  label text not null default 'Principal' check (length(btrim(label)) > 0),
  is_default boolean not null default false,

  -- Identidad fiscal del adquirente. Nulable a propósito: un perfil copiado
  -- de un cliente con datos parciales existe, pero la emisión lo bloquea y
  -- lista el faltante (la validación vive al emitir, no aquí).
  document_type_code text references public.document_types(code),
  document_number text,
  legal_name text,
  email text,
  phone text,
  organization_type text not null default '2' check (organization_type in ('1', '2')),
  tax_level_code text not null default 'R-99-PN'
    check (tax_level_code ~ '^(R-99-PN|O-(13|15|23|47)(;O-(13|15|23|47))*)$'),
  tax_scheme_code text check (tax_scheme_code in ('01', '04', 'ZA', 'ZZ')),
  applies_withholding boolean not null default false,
  delivery_method text not null default 'email' check (delivery_method in ('email', 'print')),

  -- Domicilio fiscal en columnas.
  address_line1 text,
  address_line2 text,
  country text references public.countries(code),
  state_code text,
  city_code text,
  state_province text,
  city text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null,

  -- Cliente del mismo tenant (borrar el cliente arrastra sus perfiles, igual
  -- que contact_addresses).
  constraint client_billing_profiles_client_fkey
    foreign key (tenant_id, client_id) references public.clients(tenant_id, id) on delete cascade,
  -- Geografía DIVIPOLA solo para Colombia, y siempre en pareja.
  constraint client_billing_profiles_geo_pair
    check ((state_code is null) = (city_code is null)),
  constraint client_billing_profiles_geo_only_co
    check (city_code is null or country = 'CO'),
  constraint client_billing_profiles_city_fkey
    foreign key (state_code, city_code) references public.cities(department_code, code),
  -- Soporte para las FK compuestas de carts / sales_orders.
  constraint client_billing_profiles_tenant_client_id_key unique (tenant_id, client_id, id)
);

comment on table public.client_billing_profiles is
  'Perfiles fiscales del cliente (adquirente DIAN). Autosuficientes: documento, nombre legal, correo, régimen y domicilio fiscal. Un solo is_default vivo por cliente.';

-- Un documento por cliente (entre perfiles vivos) y un único predeterminado.
create unique index client_billing_profiles_document_uidx
  on public.client_billing_profiles (tenant_id, client_id, document_number)
  where deleted_at is null and document_number is not null;
create unique index client_billing_profiles_one_default_uidx
  on public.client_billing_profiles (tenant_id, client_id)
  where is_default and deleted_at is null;

-- Índices de FK / acceso.
create index client_billing_profiles_tenant_client_idx
  on public.client_billing_profiles (tenant_id, client_id) where deleted_at is null;
create index client_billing_profiles_document_type_idx
  on public.client_billing_profiles (document_type_code) where document_type_code is not null;
create index client_billing_profiles_country_idx
  on public.client_billing_profiles (country) where country is not null;
create index client_billing_profiles_city_idx
  on public.client_billing_profiles (state_code, city_code) where city_code is not null;
create index client_billing_profiles_deleted_by_idx
  on public.client_billing_profiles (deleted_by) where deleted_by is not null;

create trigger client_billing_profiles_set_updated_at
  before update on public.client_billing_profiles
  for each row execute function public.set_updated_at();

-- El primer perfil vivo de un cliente nace como predeterminado.
create or replace function public.client_billing_profiles_first_is_default()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not new.is_default and new.deleted_at is null and not exists (
    select 1 from public.client_billing_profiles p
    where p.tenant_id = new.tenant_id and p.client_id = new.client_id
      and p.deleted_at is null and p.is_default
  ) then
    new.is_default := true;
  end if;
  return new;
end;
$$;
revoke execute on function public.client_billing_profiles_first_is_default() from public, anon, authenticated;

create trigger client_billing_profiles_first_is_default
  before insert on public.client_billing_profiles
  for each row execute function public.client_billing_profiles_first_is_default();

-- El Consumidor Final (walk-in) NO tiene perfiles de facturación: su comprador
-- sale solo de su identidad (222222222222) + el correo de cada comprobante. Un
-- perfil bajo el walk-in (y más aún uno predeterminado) permitiría facturar una
-- venta de mostrador a un tercero. Se impide en la base (insert y cambio de cliente).
create or replace function public.client_billing_profiles_no_walk_in()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from public.clients c where c.id = new.client_id and c.tenant_id = new.tenant_id and c.is_walk_in) then
    raise exception 'WALK_IN_NO_BILLING_PROFILE: el Consumidor Final no admite perfiles de facturación (el correo va por comprobante).'
      using errcode = '23514', constraint = 'client_billing_profiles_no_walk_in';
  end if;
  return new;
end;
$$;
revoke execute on function public.client_billing_profiles_no_walk_in() from public, anon, authenticated;

create trigger client_billing_profiles_no_walk_in
  before insert or update of client_id on public.client_billing_profiles
  for each row execute function public.client_billing_profiles_no_walk_in();

-- RLS estándar (4 policies).
alter table public.client_billing_profiles enable row level security;
create policy client_billing_profiles_select on public.client_billing_profiles
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy client_billing_profiles_insert on public.client_billing_profiles
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy client_billing_profiles_update on public.client_billing_profiles
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy client_billing_profiles_delete on public.client_billing_profiles
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
revoke all on public.client_billing_profiles from anon;

-- RPC atómica: marca un perfil como predeterminado de su cliente.
-- security invoker: corre con el rol del llamador, así que RLS limita a su
-- tenant; el tenant nunca llega por parámetro. Serializa por cliente con un
-- lock de fila para que dos llamadas simultáneas no choquen con el índice
-- único de predeterminado.
create or replace function public.set_default_billing_profile(p_profile_id uuid)
returns public.client_billing_profiles
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_profile public.client_billing_profiles;
  v_tenant uuid := public.auth_active_tenant_id();
begin
  select * into v_profile
    from public.client_billing_profiles p
   where p.id = p_profile_id and p.deleted_at is null;
  if not found or (v_tenant is not null and v_profile.tenant_id <> v_tenant) then
    raise exception 'Perfil de facturación no encontrado.' using errcode = 'LX404';
  end if;

  perform 1 from public.clients c
   where c.id = v_profile.client_id and c.tenant_id = v_profile.tenant_id
     for update;

  update public.client_billing_profiles p
     set is_default = false
   where p.tenant_id = v_profile.tenant_id and p.client_id = v_profile.client_id
     and p.is_default and p.deleted_at is null and p.id <> p_profile_id;

  update public.client_billing_profiles p
     set is_default = true
   where p.id = p_profile_id and p.tenant_id = v_profile.tenant_id
  returning * into v_profile;

  return v_profile;
end;
$$;

comment on function public.set_default_billing_profile(uuid) is
  'Marca un perfil de facturación como predeterminado de su cliente (desmarca el anterior) en una transacción. security invoker: el tenant lo limita RLS.';

revoke all on function public.set_default_billing_profile(uuid) from public, anon;
grant execute on function public.set_default_billing_profile(uuid) to authenticated, service_role;
