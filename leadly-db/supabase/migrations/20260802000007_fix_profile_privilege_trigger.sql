-- Fixes two issues found in QA of prevent_profile_privilege_escalation()
-- (20260802000003_rls_platform.sql):
--
-- 1. [High] A tenant_admin could change role/active on THEIR OWN row (the
--    trigger only checked old.tenant_id = auth_tenant_id(), never excluded
--    self), so a lone tenant_admin could demote themselves to tenant_agent
--    and get permanently locked out of managing their own tenant.
-- 2. [Medium] Postgres triggers fire for every role including service_role
--    (unlike RLS policies, which service_role bypasses), and this trigger's
--    checks are based on auth.uid()/auth_tenant_id() which are null for
--    service_role calls. So an Edge Function using service_role to fix a
--    profile (e.g. admin-create-tenant-user, or a support/ops fix) would
--    always be rejected with "Not authorized...". Edge Functions already
--    enforce their own authorization before touching the DB, so it's safe
--    to let service_role bypass this specific guard.

create or replace function public.prevent_profile_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;

  if new.role is distinct from old.role or new.active is distinct from old.active then
    if not (
      public.is_superadmin()
      or (
        public.is_tenant_admin()
        and old.tenant_id = public.auth_tenant_id()
        and new.tenant_id = old.tenant_id
        and old.id <> auth.uid()
      )
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
