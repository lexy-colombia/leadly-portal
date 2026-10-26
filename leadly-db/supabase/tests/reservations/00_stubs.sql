-- Esqueleto minimo de Supabase + tablas base de stock/ventas con su forma real.
-- carts/cart_items/sales_orders.cart_id/save_cart_lines/triggers de stock se crean
-- aplicando las MIGRACIONES REALES (ver run.sh).
set client_min_messages = warning;
drop schema if exists public cascade; create schema public;
drop schema if exists auth cascade; create schema auth;
drop schema if exists cron cascade; create schema cron;
drop schema if exists t cascade; create schema t;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public, auth to anon, authenticated, service_role;
grant usage on schema t to public;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;

create table cron.job(jobid serial primary key, jobname text unique, schedule text, command text);
create function cron.schedule(jobname text, schedule text, command text) returns bigint language sql as
$$ insert into cron.job(jobname, schedule, command) values (jobname, schedule, command)
   on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid::bigint $$;

create table public.tenants(id uuid primary key default gen_random_uuid(), name text not null, status text not null default 'active');
create table public.profiles(id uuid primary key, tenant_id uuid references public.tenants(id), role varchar(20) not null);
create function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
create function public.is_superadmin() returns boolean language sql stable security definer set search_path = public as
$$ select coalesce((select role = 'superadmin' from public.profiles where id = auth.uid()), false); $$;
create function public.auth_active_tenant_id() returns uuid language sql stable security definer set search_path = public as
$$ select p.tenant_id from public.profiles p join public.tenants t on t.id = p.tenant_id where p.id = auth.uid() and t.status = 'active'; $$;
grant execute on function public.is_superadmin(), public.auth_active_tenant_id() to authenticated;

-- Tablas referenciadas por carts / sales_orders (solo id)
create table public.clients(id uuid primary key default gen_random_uuid(), tenant_id uuid);
create table public.opportunities(id uuid primary key default gen_random_uuid());
create table public.contact_addresses(id uuid primary key default gen_random_uuid());
create table public.pos_points(id uuid primary key default gen_random_uuid());

-- Esquema de stock (forma real: 20260815000001, 20260819061000)
create table public.warehouses(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null, is_default boolean not null default false, is_active boolean not null default true,
  deleted_at timestamptz);
create unique index warehouses_tenant_one_default_idx on public.warehouses(tenant_id) where is_default and deleted_at is null;
create table public.products(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null, track_inventory boolean not null default true, has_variants boolean not null default false);
create table public.product_variants(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, product_id uuid not null references public.products(id), name text,
  is_active boolean not null default true, deleted_at timestamptz);
create table public.product_stock(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, product_id uuid not null references public.products(id),
  warehouse_id uuid not null references public.warehouses(id),
  variant_id uuid references public.product_variants(id),
  quantity numeric not null default 0, damaged_quantity numeric not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create unique index product_stock_no_variant_unique on public.product_stock(product_id, warehouse_id) where variant_id is null;
create unique index product_stock_variant_unique on public.product_stock(product_id, warehouse_id, variant_id) where variant_id is not null;
create table public.stock_movements(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, product_id uuid not null, warehouse_id uuid not null, variant_id uuid,
  movement_type text not null, quantity numeric not null check (quantity > 0),
  reference_type text, reference_id uuid, created_at timestamptz not null default now());
create table public.sales_orders(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  status text not null default 'cotizacion', sales_channel text, contact_id uuid, created_at timestamptz not null default now());
create table public.sales_order_items(
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.sales_orders(id) on delete cascade,
  product_id uuid, variant_id uuid, warehouse_id uuid, product_name text, quantity numeric not null);

-- Arnes de pruebas
create table t.results(n serial primary key, name text, ok boolean, detail text);
grant all on t.results to public; grant all on all sequences in schema t to public;
create function t.chk(p_name text, p_ok boolean, p_detail text default null) returns void language plpgsql as $$
begin
  insert into t.results(name, ok, detail) values (p_name, coalesce(p_ok, false), p_detail);
  if coalesce(p_ok, false) then raise notice 'PASS  %', p_name; else raise notice 'FAIL  % -- %', p_name, p_detail; end if;
end $$;
create function t.expect_error(p_name text, p_sql text, p_pattern text, p_state text default null) returns void language plpgsql as $$
declare v_msg text; v_state text;
begin
  begin
    execute p_sql;
    perform t.chk(p_name, false, 'no fallo (se esperaba error ~ ' || p_pattern || ')');
    return;
  exception when others then get stacked diagnostics v_state = returned_sqlstate; v_msg := sqlerrm;
  end;
  perform t.chk(p_name, v_msg ilike p_pattern and (p_state is null or v_state = p_state), 'sqlstate=' || v_state || ' error=' || v_msg);
end $$;
