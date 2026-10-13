-- Esqueleto minimo de Supabase + tablas base con su forma real. Todo lo de
-- billing/modulos se crea aplicando las MIGRACIONES REALES (ver run.sh).
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
-- Como Supabase: privilegios por defecto amplios; el limite real son RLS y revoke explicitos.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

-- pg_cron minimo (las migraciones hacen cron.schedule dentro de un DO)
create table cron.job(jobid serial primary key, jobname text, schedule text, command text);
create function cron.schedule(jobname text, schedule text, command text) returns bigint language sql as
$$ insert into cron.job(jobname, schedule, command) values (jobname, schedule, command) returning jobid::bigint $$;

create table public.tenants(
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'active',
  legal_name text, document_type text, document_number text,
  contact_email text, billing_address text, country text, state_province text,
  updated_at timestamptz not null default now()
);
create table public.profiles(
  id uuid primary key,
  tenant_id uuid references public.tenants(id),
  role varchar(20) not null,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);
create table public.whatsapp_lines(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  status varchar(30) not null default 'pending_verification'
);
create table public.payment_providers(key text primary key);
insert into public.payment_providers values ('wompi'), ('manual');
create table public.ai_assistant_skills(id uuid primary key default gen_random_uuid());
create table public.ai_skills(id uuid primary key default gen_random_uuid());
create table public.integration_providers(id uuid primary key default gen_random_uuid());

-- Helpers reales (20260802000002 / 20260802000009)
create or replace function public.set_updated_at() returns trigger language plpgsql as
$$ begin new.updated_at = now(); return new; end; $$;
create function public.auth_tenant_id() returns uuid language sql stable security definer set search_path = public as
$$ select tenant_id from public.profiles where id = auth.uid(); $$;
create function public.is_superadmin() returns boolean language sql stable security definer set search_path = public as
$$ select coalesce((select role = 'superadmin' from public.profiles where id = auth.uid()), false); $$;
create function public.auth_active_tenant_id() returns uuid language sql stable security definer set search_path = public as
$$ select p.tenant_id from public.profiles p join public.tenants t on t.id = p.tenant_id where p.id = auth.uid() and t.status = 'active'; $$;
revoke execute on function public.is_superadmin(), public.auth_active_tenant_id(), public.auth_tenant_id() from public, anon;
grant execute on function public.is_superadmin(), public.auth_active_tenant_id(), public.auth_tenant_id() to authenticated;

-- Arnes de pruebas
create table t.results(n serial primary key, name text, ok boolean, detail text);
grant all on t.results to public; grant all on all sequences in schema t to public;
create function t.chk(p_name text, p_ok boolean, p_detail text default null) returns void language plpgsql as $$
begin
  insert into t.results(name, ok, detail) values (p_name, coalesce(p_ok, false), p_detail);
  if coalesce(p_ok, false) then raise notice 'PASS  %', p_name;
  else raise notice 'FAIL  % -- %', p_name, p_detail; end if;
end $$;
-- ejecuta sql en subtransaccion y exige que falle con un mensaje que cumpla el patron
create function t.expect_error(p_name text, p_sql text, p_pattern text) returns void language plpgsql as $$
declare v_msg text;
begin
  begin
    execute p_sql;
    perform t.chk(p_name, false, 'no fallo (se esperaba error ~ ' || p_pattern || ')');
    return;
  exception when others then v_msg := sqlerrm;
  end;
  perform t.chk(p_name, v_msg ilike p_pattern, 'error=' || v_msg);
end $$;
create function t.mk_tenant(p_name text) returns uuid language sql as
$$ insert into public.tenants(name) values (p_name) returning id $$;
