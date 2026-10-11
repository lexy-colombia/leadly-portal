-- Simula lo minimo de Supabase para correr la migracion en un Postgres 15
-- descartable. NO es parte de la migracion ni se aplica a produccion.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;

-- Default privileges tipicos de Supabase en public (los EXECUTE a anon/authenticated
-- son justamente lo que la migracion debe revocar).
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

create schema if not exists vault;
create table if not exists vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text, description text);
create or replace view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
create or replace function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid
 language sql as $$ insert into vault.secrets(name, secret, description) values (new_name, new_secret, new_description) returning id $$;
create or replace function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null) returns void
 language sql as $$ update vault.secrets set secret = coalesce(new_secret, secret) where id = secret_id $$;

create schema if not exists net;
create table if not exists net.calls (id bigserial primary key, url text, headers jsonb, body jsonb, at timestamptz default now());
create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}') returns bigint
 language sql as $$ insert into net.calls(url, headers, body) values (url, headers, body) returning id $$;

create schema if not exists cron;
create table if not exists cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint
 language sql as $$ insert into cron.job(jobname, schedule, command) values (job_name, schedule, command)
   on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $$;
create or replace function cron.unschedule(job_name text) returns boolean
 language sql as $$ delete from cron.job where jobname = job_name returning true $$;

create table if not exists public.internal_secrets (key text primary key, secret_id uuid not null);
revoke all on public.internal_secrets from anon, authenticated;
