-- Plans can now cap how many active users a tenant may have -- enforced for
-- real (not just a UI hint) via a trigger on profiles, the same principle
-- already applied to ai_skills ("la activación es real, no solo texto", see
-- CLAUDE.md 3.5): it fires regardless of whether the row comes from
-- admin-create-tenant-user (service_role, bypasses RLS) or a direct
-- setProfileActive update from the client (RLS), so neither path can be used
-- to sneak past the limit.
alter table public.billing_plans
  add column max_users integer check (max_users is null or max_users > 0);

comment on column public.billing_plans.max_users is 'Máximo de usuarios activos que un tenant en este plan puede tener. NULL = sin límite.';

-- Fires on insert (a freshly invited user is active=true by default) and on
-- any update that sets active -- but only actually checks the limit when the
-- row is *becoming* active (false->true, or a brand-new active row), never
-- on deactivation or on unrelated edits to an already-active row.
create or replace function public.enforce_plan_max_users() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_became_active boolean;
  v_max integer;
  v_count integer;
begin
  if tg_op = 'INSERT' then
    v_became_active := new.active;
  else
    v_became_active := new.active and (old.active is distinct from true);
  end if;

  if not v_became_active or new.tenant_id is null then
    return new;
  end if;

  select bp.max_users into v_max
  from public.billing_subscriptions bs
  join public.billing_plans bp on bp.id = bs.plan_id
  where bs.tenant_id = new.tenant_id
  order by bs.created_at desc
  limit 1;

  if v_max is null then
    return new;
  end if;

  select count(*) into v_count
  from public.profiles
  where tenant_id = new.tenant_id and active = true and id <> new.id;

  if v_count >= v_max then
    raise exception 'Este plan permite un máximo de % usuarios activos.', v_max;
  end if;

  return new;
end;
$$;

create trigger profiles_enforce_plan_max_users
  before insert or update of active on public.profiles
  for each row execute function public.enforce_plan_max_users();
