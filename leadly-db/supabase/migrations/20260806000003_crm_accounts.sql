-- crm_accounts: the B2B "empresa cliente" layer that crm_contacts.company
-- (a free-text string) couldn't represent -- lets a tenant group several
-- contacts under one real company (see multiple contacts at the same
-- business), and is the anchor account-level opportunities attach to.
-- crm_contacts.company stays as-is for now (existing free-text data, still
-- read by the UI) -- revisit once account adoption is real, don't force a
-- migration of unstructured text into rows today.
create table public.crm_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  nit text,
  industry text,
  phone text,
  email text,
  website text,
  address text,
  city text,
  owner_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

create index crm_accounts_tenant_id_idx on public.crm_accounts(tenant_id);

create trigger crm_accounts_set_updated_at
  before update on public.crm_accounts
  for each row execute function public.set_updated_at();

alter table public.crm_accounts enable row level security;

create policy crm_accounts_select on public.crm_accounts
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy crm_accounts_insert on public.crm_accounts
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy crm_accounts_update on public.crm_accounts
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

-- Backstop only, same as crm_contacts -- app code always soft-deletes
-- (deleted_at/deleted_by), never exercises this policy itself.
create policy crm_accounts_delete on public.crm_accounts
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.crm_accounts from anon;

-- Optional link: a contact may belong to an account (B2B) or stand alone
-- (B2C/individual) -- nullable on purpose.
alter table public.crm_contacts add column account_id uuid references public.crm_accounts(id) on delete set null;
create index crm_contacts_account_id_idx on public.crm_contacts(account_id);
