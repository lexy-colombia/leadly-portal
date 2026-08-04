-- Security advisor findings (get_advisors) after the Clientes module work:
--
-- 1. `revoke execute ... from public` (used throughout earlier migrations) does
--    NOT remove Supabase's own default grants to `anon`/`authenticated` --
--    those are applied directly to those roles via ALTER DEFAULT PRIVILEGES
--    at the project level, not inherited through the PUBLIC pseudo-role. Every
--    SECURITY DEFINER helper in this schema was therefore still directly
--    callable by `anon` (unauthenticated) as a REST RPC endpoint. In practice
--    each one self-guards on auth.uid() being null (returns null/false/raises
--    "Must be authenticated"), so this was not an active data leak, but an
--    anonymous caller should not be able to invoke authorization helpers at
--    all -- revoke from anon explicitly on every one of them.
-- 2. `set_updated_at` was missing `set search_path = public` (function_search_path_mutable).
--
-- authenticated keeps EXECUTE where the function is legitimately used from
-- RLS policies evaluated in an authenticated request context, or is meant to
-- be called directly (self_register_tenant).

revoke execute on function public.auth_tenant_id() from anon;
revoke execute on function public.auth_role() from anon;
revoke execute on function public.is_superadmin() from anon;
revoke execute on function public.is_tenant_admin() from anon;
revoke execute on function public.auth_active_tenant_id() from anon;
revoke execute on function public.self_register_tenant(text, text) from anon;
revoke execute on function public.set_updated_at() from anon;
revoke execute on function public.prevent_profile_privilege_escalation() from anon;
revoke execute on function public.check_conversation_tenant_matches_line() from anon;
revoke execute on function public.bump_conversation_last_message_at() from anon;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke execute on function public.set_updated_at() from anon;
