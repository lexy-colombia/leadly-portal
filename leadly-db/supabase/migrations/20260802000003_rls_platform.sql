-- Row Level Security for tenants and profiles.
-- Standard policy: superadmin sees/edits everything. A tenant user sees only
-- their own tenant row / profiles of their own tenant. tenants and profiles
-- creation/deletion is restricted to superadmin (or tenant_admin for profiles
-- of their own tenant) -- tenants themselves are only created by superadmin
-- since that is the onboarding step of a new Leadly customer.

alter table public.tenants enable row level security;

create policy tenants_select on public.tenants
  for select using (id = public.auth_tenant_id() or public.is_superadmin());

create policy tenants_superadmin_write on public.tenants
  for insert with check (public.is_superadmin());

create policy tenants_superadmin_update on public.tenants
  for update using (public.is_superadmin()) with check (public.is_superadmin());

create policy tenants_superadmin_delete on public.tenants
  for delete using (public.is_superadmin());

alter table public.profiles enable row level security;

create policy profiles_select on public.profiles
  for select using (
    id = auth.uid()
    or tenant_id = public.auth_tenant_id()
    or public.is_superadmin()
  );

create policy profiles_insert on public.profiles
  for insert with check (
    public.is_superadmin()
    or (public.is_tenant_admin() and tenant_id = public.auth_tenant_id())
  );

create policy profiles_update on public.profiles
  for update using (
    id = auth.uid()
    or public.is_superadmin()
    or (public.is_tenant_admin() and tenant_id = public.auth_tenant_id())
  )
  with check (
    id = auth.uid()
    or public.is_superadmin()
    or (public.is_tenant_admin() and tenant_id = public.auth_tenant_id())
  );

create policy profiles_delete on public.profiles
  for delete using (
    public.is_superadmin()
    or (public.is_tenant_admin() and tenant_id = public.auth_tenant_id())
  );

-- Defense in depth: even though profile writes go through Edge Functions with
-- service_role in practice (see admin-create-tenant-user), revoke direct
-- table privileges from anon entirely. authenticated keeps privileges gated
-- by the policies above.
revoke all on public.tenants from anon;
revoke all on public.profiles from anon;

-- profiles_update above lets a user update their OWN row (id = auth.uid()) so
-- they can edit full_name/phone from a "my account" screen without an admin.
-- RLS is row-level, not column-level, so without this trigger that same
-- policy would let a tenant_agent PATCH their own role to 'superadmin' or
-- move themselves to another tenant_id. Block privilege-bearing columns from
-- self-service edits; only superadmin (any field) or tenant_admin (role/active
-- of their own tenant, never tenant_id) may change them.
create or replace function public.prevent_profile_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role or new.active is distinct from old.active then
    if not (
      public.is_superadmin()
      or (public.is_tenant_admin() and old.tenant_id = public.auth_tenant_id() and new.tenant_id = old.tenant_id)
    ) then
      raise exception 'Not authorized to change role/active on this profile';
    end if;
  end if;

  if new.tenant_id is distinct from old.tenant_id and not public.is_superadmin() then
    raise exception 'Not authorized to reassign tenant_id on this profile';
  end if;

  return new;
end;
$$;

revoke execute on function public.prevent_profile_privilege_escalation() from public;

create trigger trg_profiles_prevent_privilege_escalation
  before update on public.profiles
  for each row execute function public.prevent_profile_privilege_escalation();
