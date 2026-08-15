-- Colombian electronic invoicing (DIAN) needs the buyer's fiscal data and a
-- tax breakdown on every invoice -- neither exists on payment_invoices today
-- (amount_cents is just a tax-inclusive total). This only prepares the data;
-- actually emitting a real electronic invoice (CUFE, UBL XML, authorized
-- numbering range) requires contracting a certified provider (Siigo/Alegra/
-- Factus/etc.), a separate project -- see CLAUDE.md decision log.
alter table public.payment_invoices
  add column buyer_legal_name text,
  add column buyer_document_type text,
  add column buyer_document_number text,
  add column buyer_email text,
  add column buyer_address text,
  add column buyer_country text,
  add column buyer_state_province text,
  add column subtotal_cents integer,
  add column tax_cents integer,
  add column tax_rate numeric(5,2) not null default 19;

comment on column public.payment_invoices.buyer_legal_name is 'Snapshot del comprador (tenant) al momento de emitir la factura -- no cambia si el tenant edita sus datos después.';
comment on column public.payment_invoices.tax_rate is 'Tasa de IVA aplicada (%). 19 por defecto (tarifa general colombiana para servicios SaaS) -- editable por factura, no constituye asesoría fiscal.';

-- Fills buyer_*/subtotal_cents/tax_cents automatically on insert so neither
-- call site that creates a payment_invoices row (process_recurring_billing_
-- invoices, and the frontend's manual-invoice insert) has to duplicate this
-- logic. Only fills fields the caller left null, so an explicit value always
-- wins.
create or replace function public.snapshot_invoice_buyer_and_tax() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant record;
begin
  if new.buyer_legal_name is null and new.payer_tenant_id is not null then
    select legal_name, name, document_type, document_number, contact_email, billing_address, country, state_province
      into v_tenant
    from public.tenants
    where id = new.payer_tenant_id;

    if found then
      new.buyer_legal_name := coalesce(v_tenant.legal_name, v_tenant.name);
      new.buyer_document_type := v_tenant.document_type;
      new.buyer_document_number := v_tenant.document_number;
      new.buyer_email := v_tenant.contact_email;
      new.buyer_address := v_tenant.billing_address;
      new.buyer_country := v_tenant.country;
      new.buyer_state_province := v_tenant.state_province;
    end if;
  end if;

  if new.subtotal_cents is null then
    new.subtotal_cents := round(new.amount_cents / (1 + new.tax_rate / 100))::integer;
    new.tax_cents := new.amount_cents - new.subtotal_cents;
  end if;

  return new;
end;
$$;

create trigger payment_invoices_snapshot_buyer_and_tax
  before insert on public.payment_invoices
  for each row execute function public.snapshot_invoice_buyer_and_tax();
