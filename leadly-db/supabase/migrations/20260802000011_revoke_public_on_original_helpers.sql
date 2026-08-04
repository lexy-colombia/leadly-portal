-- Second pass on the same finding as 20260802000010: auth_tenant_id(),
-- auth_role(), is_superadmin() and is_tenant_admin() (20260802000002_helpers.sql)
-- were the only helpers created without `revoke execute ... from public`, so
-- besides anon's now-revoked direct grant, they still carried the implicit
-- PUBLIC grant Postgres adds at CREATE FUNCTION time -- and PUBLIC is checked
-- independently of a role's own grants, so anon (and any future role) could
-- still call them through that channel. Revoke from public here to close it.
revoke execute on function public.auth_tenant_id() from public;
revoke execute on function public.auth_role() from public;
revoke execute on function public.is_superadmin() from public;
revoke execute on function public.is_tenant_admin() from public;

grant execute on function public.auth_tenant_id() to authenticated;
grant execute on function public.auth_role() to authenticated;
grant execute on function public.is_superadmin() to authenticated;
grant execute on function public.is_tenant_admin() to authenticated;
