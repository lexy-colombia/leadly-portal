set client_min_messages = warning;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator nologin; end if;
  if not exists (select 1 from pg_roles where rolname='supabase_admin') then create role supabase_admin nologin; end if;
end $$;
create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions; create extension if not exists unaccent;
create extension if not exists pgcrypto; 
create schema if not exists auth; create schema if not exists cron; create schema if not exists vault; create schema if not exists storage; create schema if not exists net;
grant usage on schema public, auth, extensions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create table auth.users(id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}', created_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true),''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')) $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}') $$;
create table cron.job(jobid serial primary key, jobname text unique, schedule text, command text);
create function cron.schedule(jobname text, schedule text, command text) returns bigint language sql as
$$ insert into cron.job(jobname, schedule, command) values (jobname, schedule, command) on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid::bigint $$;
create function cron.unschedule(jobname text) returns boolean language sql as $$ select true $$;
create function cron.unschedule(jobid bigint) returns boolean language sql as $$ select true $$;
create table vault.secrets(id uuid primary key default gen_random_uuid(), name text unique, secret text, description text, created_at timestamptz default now(), updated_at timestamptz default now());
create view vault.decrypted_secrets as select id, name, secret as decrypted_secret, description from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid language sql as
$$ insert into vault.secrets(name, secret, description) values (new_name, new_secret, new_description) returning id $$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null) returns void language sql as
$$ update vault.secrets set secret = coalesce(new_secret, secret) where id = secret_id $$;
create table storage.buckets(id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now());
create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, created_at timestamptz default now());
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql as $$ select string_to_array(name, '/') $$;
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;
create publication supabase_realtime;
