-- Shared helper functions: updated_at maintenance and auth/RLS helpers.
-- auth_tenant_id/auth_role/is_superadmin/is_tenant_admin are SECURITY DEFINER so
-- RLS policies on public.profiles can call them without causing policy recursion.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke execute on function public.set_updated_at() from public;

create trigger trg_tenants_updated_at before update on public.tenants
  for each row execute function public.set_updated_at();
create trigger trg_profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

create or replace function public.auth_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select tenant_id from public.profiles where id = auth.uid();
$$;

create or replace function public.auth_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_superadmin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select role = 'superadmin' from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.is_tenant_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select role = 'tenant_admin' from public.profiles where id = auth.uid()), false);
$$;

grant execute on function public.auth_tenant_id() to authenticated;
grant execute on function public.auth_role() to authenticated;
grant execute on function public.is_superadmin() to authenticated;
grant execute on function public.is_tenant_admin() to authenticated;
