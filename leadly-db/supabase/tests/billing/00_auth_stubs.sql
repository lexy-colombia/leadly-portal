-- Sobrescribe los stubs de auth de tests/barriles_subscription con los de Supabase REAL:
-- auth.uid()/auth.role() leen request.jwt.claims (JSON) y, por compatibilidad, request.jwt.claim.*.
-- Sin claims (pg_cron, SQL directo como postgres) ambos devuelven NULL.
set client_min_messages = warning;
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid $$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text $$;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;

-- La tabla real tiene created_at (el guard de escalada lo compara); el stub base no.
alter table public.tenants add column if not exists created_at timestamptz not null default now();
