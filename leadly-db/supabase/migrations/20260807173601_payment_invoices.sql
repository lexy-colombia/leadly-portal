-- Generic invoice table: serves the platform-bills-tenant case today
-- (merchant_tenant_id null = Leadly is the merchant, payer_tenant_id = the
-- tenant being billed, subscription_id set) and is shaped so the
-- tenant-bills-their-own-customer case can be added later WITHOUT another
-- migration to this table: merchant_tenant_id would simply be set to that
-- tenant, and whoever pays would still be identified the same way payers are
-- identified everywhere else in this schema. No speculative payer_contact_id
-- column added now -- YAGNI until that case has a real UI/Edge Function
-- consumer (see CLAUDE.md 3.6 on avoiding over-building without a real use
-- case).
create table public.payment_invoices (
  id uuid primary key default gen_random_uuid(),
  merchant_tenant_id uuid references public.tenants(id) on delete cascade,
  payer_tenant_id uuid references public.tenants(id) on delete cascade,
  subscription_id uuid references public.billing_subscriptions(id) on delete set null,
  provider_key text not null references public.payment_providers(key) on delete restrict,
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null default 'COP',
  status text not null default 'PENDING'
    check (status in ('PENDING', 'PAID', 'OVERDUE', 'CANCELLED', 'REFUNDED')),
  invoice_number text,
  description text,
  due_date date,
  provider_checkout_id text,
  provider_transaction_id text,
  provider_payment_method text,
  provider_payment_data jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

create index payment_invoices_payer_tenant_id_idx on public.payment_invoices(payer_tenant_id);
create index payment_invoices_merchant_tenant_id_idx on public.payment_invoices(merchant_tenant_id);
create index payment_invoices_subscription_id_idx on public.payment_invoices(subscription_id);
create index payment_invoices_provider_checkout_id_idx on public.payment_invoices(provider_checkout_id);

create trigger payment_invoices_set_updated_at
  before update on public.payment_invoices
  for each row execute function public.set_updated_at();

alter table public.payment_invoices enable row level security;

create policy payment_invoices_select on public.payment_invoices
  for select to authenticated using (
    public.is_superadmin() or payer_tenant_id = public.auth_active_tenant_id()
  );

create policy payment_invoices_superadmin_write on public.payment_invoices
  for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin());

revoke all on public.payment_invoices from anon;
