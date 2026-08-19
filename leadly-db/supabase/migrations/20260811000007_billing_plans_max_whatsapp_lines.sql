-- Same pattern as max_users (20260811000006): plans can cap how many
-- WhatsApp lines a tenant may have connected (status='active') at once,
-- enforced by a trigger so it's real regardless of which path sets a line
-- active -- the backoffice's manual status change (setWhatsappLineStatus,
-- direct RLS update) or the tenant's own Embedded Signup connect
-- (whatsapp-embedded-signup Edge Function, service_role insert with
-- status='active' from the start).
alter table public.billing_plans
  add column max_whatsapp_lines integer check (max_whatsapp_lines is null or max_whatsapp_lines > 0);

comment on column public.billing_plans.max_whatsapp_lines is 'Máximo de líneas de WhatsApp activas que un tenant en este plan puede tener conectadas. NULL = sin límite.';

create or replace function public.enforce_plan_max_whatsapp_lines() returns trigger
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
    v_became_active := new.status = 'active';
  else
    v_became_active := new.status = 'active' and (old.status is distinct from 'active');
  end if;

  if not v_became_active then
    return new;
  end if;

  select bp.max_whatsapp_lines into v_max
  from public.billing_subscriptions bs
  join public.billing_plans bp on bp.id = bs.plan_id
  where bs.tenant_id = new.tenant_id
  order by bs.created_at desc
  limit 1;

  if v_max is null then
    return new;
  end if;

  select count(*) into v_count
  from public.whatsapp_lines
  where tenant_id = new.tenant_id and status = 'active' and id <> new.id;

  if v_count >= v_max then
    raise exception 'Este plan permite un máximo de % líneas de WhatsApp activas.', v_max;
  end if;

  return new;
end;
$$;

create trigger whatsapp_lines_enforce_plan_max_lines
  before insert or update of status on public.whatsapp_lines
  for each row execute function public.enforce_plan_max_whatsapp_lines();
