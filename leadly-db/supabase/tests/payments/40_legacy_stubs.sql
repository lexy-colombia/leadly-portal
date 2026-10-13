-- Simula, con su FORMA REAL (columnas, checks e indices de las migraciones
-- 20260807173601 / 20260807173612 / 20260825190000 / 20260822020001), las tablas
-- legacy de `public` contra las que el receptor resuelve origenes (2) y (3).
-- Solo para la prueba de integracion: NO es parte de ninguna migracion.
create table public.tenants (id uuid primary key default gen_random_uuid(), name text);
create table public.profiles (id uuid primary key);
create table public.sales_orders (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id), number int, status text, total numeric(14,2), currency text default 'COP', deleted_at timestamptz);
create table public.payment_providers (key text primary key);
insert into public.payment_providers values ('wompi'), ('manual');
create table public.billing_subscriptions (id uuid primary key default gen_random_uuid(), status text default 'PENDING', current_period_end timestamptz);

create table public.payment_invoices (
  id uuid primary key default gen_random_uuid(),
  merchant_tenant_id uuid references public.tenants(id) on delete cascade,
  payer_tenant_id uuid references public.tenants(id) on delete cascade,
  subscription_id uuid references public.billing_subscriptions(id) on delete set null,
  provider_key text not null references public.payment_providers(key) on delete restrict,
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null default 'COP',
  status text not null default 'PENDING' check (status in ('PENDING', 'PAID', 'OVERDUE', 'CANCELLED', 'REFUNDED')),
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
create index payment_invoices_provider_checkout_id_idx on public.payment_invoices(provider_checkout_id);

create table public.payment_attempts (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.payment_invoices(id) on delete cascade,
  provider_key text not null references public.payment_providers(key) on delete restrict,
  provider_transaction_id text,
  status text not null,
  amount_cents integer,
  currency text,
  payment_method text,
  payment_brand text,
  payment_last_four text,
  payment_bank text,
  payment_reference text,
  raw_data jsonb,
  created_at timestamptz not null default now()
);

-- trigger real (resumido): factura PAID -> suscripcion ACTIVE, una sola vez.
create or replace function public.activate_subscription_on_invoice_paid() returns trigger
language plpgsql as $$
begin
  if new.status = 'PAID' and old.status is distinct from 'PAID' and new.subscription_id is not null then
    update public.billing_subscriptions set status = 'ACTIVE' where id = new.subscription_id;
  end if;
  return new;
end $$;
create trigger payment_invoices_activate_subscription after update on public.payment_invoices
  for each row execute function public.activate_subscription_on_invoice_paid();

create table public.sales_order_payment_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  order_id uuid not null references public.sales_orders(id),
  provider_key text not null,
  provider_checkout_id text not null,
  checkout_url text not null,
  amount numeric(14,2) not null check (amount > 0),
  currency text not null default 'COP',
  status text not null default 'pending' check (status in ('pending', 'paid', 'expired', 'cancelled')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index sales_order_payment_links_provider_checkout_idx
  on public.sales_order_payment_links (provider_key, provider_checkout_id);

create table public.sales_order_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  order_id uuid not null references public.sales_orders(id),
  method text not null check (method = any (array['efectivo','transferencia','tarjeta','otro','credito','saldo_favor','wompi'])),
  amount numeric(14,2) not null,
  currency text default 'COP',
  notes text,
  deleted_at timestamptz,
  provider_key text,
  provider_transaction_id text,
  provider_reference text,
  payment_link_id uuid references public.sales_order_payment_links(id),
  created_at timestamptz not null default now()
);
create unique index sales_order_payments_payment_link_idx
  on public.sales_order_payments (payment_link_id) where payment_link_id is not null;

create table public.tenant_payment_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id),
  provider_key text not null,
  mode text not null check (mode in ('sandbox','production')),
  config jsonb default '{}',
  is_active boolean not null default true,
  deleted_at timestamptz
);
create table public.test_credential_secrets (credential_id uuid, name text, value text, primary key (credential_id, name));
create or replace function public.get_payment_credential_secret(p_credential_id uuid, p_secret_name text) returns text
language sql stable as $$ select value from public.test_credential_secrets where credential_id = p_credential_id and name = p_secret_name $$;

grant all on all tables in schema public to service_role;
