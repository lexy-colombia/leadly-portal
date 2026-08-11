-- Leadly's own plan catalog -- first real consumer of the payments module
-- (Leadly billing its tenants). Superadmin-managed, same visibility pattern
-- as payment_providers/ai_skills (readable by any authenticated user so a
-- tenant's own billing screen can show its plan name/price, writable only
-- by superadmin).
create table public.billing_plans (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  name text not null,
  description text,
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null default 'COP',
  billing_interval text not null check (billing_interval in ('monthly', 'yearly')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger billing_plans_set_updated_at
  before update on public.billing_plans
  for each row execute function public.set_updated_at();

alter table public.billing_plans enable row level security;

create policy billing_plans_select on public.billing_plans
  for select to authenticated using (true);

create policy billing_plans_superadmin_write on public.billing_plans
  for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin());

revoke all on public.billing_plans from anon;
