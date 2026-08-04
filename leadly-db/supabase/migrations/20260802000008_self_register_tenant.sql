-- Self-service signup: a newly authenticated user (Google or email/password)
-- with no profiles row yet can create their own tenant and become its
-- tenant_admin in one atomic step. Product decision (see CLAUDE.md): signup
-- stays open, but "belonging to a tenant" is still only ever decided by a
-- profiles row -- this RPC is simply the self-service way of creating one,
-- alongside the superadmin backoffice CRUD.
--
-- SECURITY DEFINER is required because the normal INSERT policies on tenants
-- restrict writes to is_superadmin(); this function is the one deliberate,
-- narrow exception, and it enforces its own invariants below rather than
-- relying on the caller having any table privilege.
create or replace function public.self_register_tenant(p_tenant_name text, p_full_name text default null)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_id uuid := auth.uid();
  caller_email text;
  caller_full_name text;
  new_tenant_id uuid;
  new_profile public.profiles;
begin
  if caller_id is null then
    raise exception 'Must be authenticated';
  end if;

  if exists (select 1 from public.profiles where id = caller_id) then
    raise exception 'This account already belongs to a tenant';
  end if;

  if btrim(coalesce(p_tenant_name, '')) = '' then
    raise exception 'p_tenant_name is required';
  end if;

  select email into caller_email from auth.users where id = caller_id;
  if caller_email is null then
    raise exception 'Caller has no email on record';
  end if;

  caller_full_name := nullif(btrim(coalesce(p_full_name, '')), '');
  if caller_full_name is null then
    caller_full_name := nullif(btrim(split_part(caller_email, '@', 1)), '');
  end if;
  if caller_full_name is null then
    caller_full_name := 'Admin';
  end if;

  insert into public.tenants (name, status, contact_email)
  values (btrim(p_tenant_name), 'active', caller_email)
  returning id into new_tenant_id;

  insert into public.profiles (id, tenant_id, full_name, email, role)
  values (caller_id, new_tenant_id, caller_full_name, caller_email, 'tenant_admin')
  returning * into new_profile;

  return new_profile;
end;
$$;

revoke execute on function public.self_register_tenant(text, text) from public;
grant execute on function public.self_register_tenant(text, text) to authenticated;
