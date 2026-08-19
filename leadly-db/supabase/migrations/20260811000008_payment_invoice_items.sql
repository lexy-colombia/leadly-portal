-- Invoices had no line items -- just one flat amount_cents + a free-text
-- description, so there was nothing to show what was actually being
-- charged. This is also a real DIAN requirement for a Colombian electronic
-- invoice (concepto/cantidad/valor unitario per line), same reasoning as the
-- buyer snapshot + tax breakdown added in 20260811000004. Multiple items per
-- invoice are supported (e.g. plan + a one-off charge in the same manual
-- invoice) even though today's two creation paths (recurring cron, the
-- initial-invoice trigger below) each only ever insert one.
create table public.payment_invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.payment_invoices(id) on delete cascade,
  description text not null,
  quantity numeric not null default 1 check (quantity > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  subtotal_cents integer not null check (subtotal_cents >= 0),
  display_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index payment_invoice_items_invoice_id_idx on public.payment_invoice_items(invoice_id);

alter table public.payment_invoice_items enable row level security;

-- Same visibility as the parent invoice: superadmin sees everything, a
-- tenant sees only items on its own invoices.
create policy payment_invoice_items_select on public.payment_invoice_items
  for select to authenticated using (
    public.is_superadmin()
    or exists (
      select 1 from public.payment_invoices i
      where i.id = payment_invoice_items.invoice_id
      and i.payer_tenant_id = public.auth_active_tenant_id()
    )
  );

create policy payment_invoice_items_superadmin_write on public.payment_invoice_items
  for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin());

revoke all on public.payment_invoice_items from anon;
