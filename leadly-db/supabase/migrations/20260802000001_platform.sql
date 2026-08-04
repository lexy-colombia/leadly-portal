-- Platform domain: tenants (clientes de Leadly) y perfiles de usuario.
-- Reference: CLAUDE.md seccion 3.1

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name varchar(150) not null,
  status varchar(20) not null default 'active' check (status in ('active', 'inactive')),
  contact_email varchar(120),
  contact_phone varchar(30),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenants_name_not_blank check (btrim(name) <> '')
);
comment on table public.tenants is 'Platform customer (tenant) of Leadly. One business using the WhatsApp AI assistant product.';

create index idx_tenants_status on public.tenants(status);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  tenant_id uuid references public.tenants(id) on delete restrict,
  full_name varchar(150) not null,
  email varchar(120) not null,
  phone varchar(30),
  role varchar(20) not null check (role in ('superadmin', 'tenant_admin', 'tenant_agent')),
  active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_full_name_not_blank check (btrim(full_name) <> ''),
  constraint profiles_tenant_role_consistency check (
    (role = 'superadmin' and tenant_id is null)
    or (role in ('tenant_admin', 'tenant_agent') and tenant_id is not null)
  )
);
comment on table public.profiles is 'System users, extends auth.users. tenant_id is NULL only for platform superadmin.';

create index idx_profiles_tenant_id on public.profiles(tenant_id);
create index idx_profiles_role on public.profiles(role);

-- on delete restrict on tenant_id: a tenant with active users cannot be hard-deleted
-- accidentally; deactivate via tenants.status instead. Superadmin profiles keep
-- tenant_id null and are never affected.
