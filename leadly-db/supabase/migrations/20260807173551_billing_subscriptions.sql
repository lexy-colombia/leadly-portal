create table public.billing_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  plan_id uuid not null references public.billing_plans(id) on delete restrict,
  status text not null default 'PENDING_PAYMENT'
    check (status in ('ACTIVE', 'CANCELLED', 'PAST_DUE', 'EXPIRED', 'PENDING_PAYMENT')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  cancelled_at timestamptz
);

create index billing_subscriptions_tenant_id_idx on public.billing_subscriptions(tenant_id);

create trigger billing_subscriptions_set_updated_at
  before update on public.billing_subscriptions
  for each row execute function public.set_updated_at();

alter table public.billing_subscriptions enable row level security;

create policy billing_subscriptions_select on public.billing_subscriptions
  for select to authenticated using (
    public.is_superadmin() or tenant_id = public.auth_active_tenant_id()
  );

-- Only superadmin/service_role create or change a subscription -- there is
-- no self-service "cambiar de plan" flow yet, matches the "keys las carga el
-- superadmin" decision applied consistently across this module.
create policy billing_subscriptions_superadmin_write on public.billing_subscriptions
  for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin());

revoke all on public.billing_subscriptions from anon;
