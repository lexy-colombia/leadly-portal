-- Generic payments module, step 1: the provider catalog. Modeled on the
-- Wompi integration already proven in production in the sibling `lexy`
-- project, but generalized so a payment provider's credentials can live
-- either at the platform level (Leadly billing its tenants, the first real
-- consumer -- see billing_plans/billing_subscriptions below) or scoped to a
-- single tenant (a tenant billing its own end customers, schema-ready but
-- not built yet -- no UI/Edge Function consumes that path today).
create table public.payment_providers (
  key text primary key,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger payment_providers_set_updated_at
  before update on public.payment_providers
  for each row execute function public.set_updated_at();

alter table public.payment_providers enable row level security;

create policy payment_providers_select on public.payment_providers
  for select to authenticated using (true);

create policy payment_providers_superadmin_write on public.payment_providers
  for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin());

revoke all on public.payment_providers from anon;

insert into public.payment_providers (key, name) values ('wompi', 'Wompi');
