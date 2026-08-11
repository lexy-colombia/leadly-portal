-- Append-only ledger of every payment attempt reported by a provider
-- (approved or not), same spirit as whatsapp_messages/crm_notes -- never
-- updated or deleted by the app, only inserted by the webhook/reconciliation
-- Edge Functions (service_role, bypasses RLS) for audit history.
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

create index payment_attempts_invoice_id_idx on public.payment_attempts(invoice_id);

alter table public.payment_attempts enable row level security;

create policy payment_attempts_select on public.payment_attempts
  for select to authenticated using (
    public.is_superadmin()
    or exists (
      select 1 from public.payment_invoices i
      where i.id = payment_attempts.invoice_id
      and i.payer_tenant_id = public.auth_active_tenant_id()
    )
  );

-- No insert/update/delete policy for authenticated -- app code never writes
-- here directly, only Edge Functions via service_role (bypasses RLS). This
-- is a hard backstop, same pattern as ai_assistant_skills/crm history
-- tables.
revoke all on public.payment_attempts from anon;
revoke insert, update, delete on public.payment_attempts from authenticated;
