-- Facturas electrónicas DIAN del tenant a sus propios clientes -- tabla
-- nueva, separada de payment_invoices (que es exclusivamente Leadly
-- facturándole la suscripción al tenant, no se toca ni se reusa).
--
-- No es 1:1 con sales_orders: un pedido puede tener varios INTENTOS de
-- factura (la DIAN puede rechazar; el reintento es una fila nueva con
-- attempt_number+1, nunca se edita el intento rechazado -- auditoría legal
-- completa). El índice único parcial permite como máximo un intento "vivo"
-- por pedido a la vez.
--
-- Sin soft-delete: una factura DIAN es un registro legal con numeración
-- consecutiva obligatoria -- "eliminar" no es una acción soportada acá,
-- invalidar una ya enviada es el flujo de nota-crédito de una fase futura
-- (status='voided', ya reservado).
--
-- buyer_snapshot/seller_snapshot son jsonb con una forma concreta y
-- documentada (no abierta) -- se arman una sola vez en
-- queueInvoiceGeneration a partir de clients/contact_addresses/tenants/
-- tenant_dian_profile, para que las fases futuras (generar XML/CUFE/firmar/
-- enviar) solo lean, sin necesitar ningún ALTER TABLE nuevo.
create table public.sales_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id uuid not null references public.sales_orders(id) on delete restrict,
  attempt_number integer not null default 1,
  status text not null default 'pending'
    check (status in ('pending', 'blocked_missing_buyer_data', 'generating', 'generated', 'sending', 'sent', 'accepted', 'rejected', 'error', 'voided')),
  status_detail text,
  invoice_prefix text,
  invoice_number bigint,
  currency text not null default 'COP',
  issue_date timestamptz,
  buyer_snapshot jsonb not null default '{}'::jsonb,
  seller_snapshot jsonb not null default '{}'::jsonb,
  subtotal numeric not null default 0,
  tax_total numeric not null default 0,
  withholding_total numeric not null default 0,
  total numeric not null default 0,
  cufe text,
  xml_storage_path text,
  dian_tracking_id text,
  dian_response jsonb,
  sent_at timestamptz,
  accepted_at timestamptz,
  rejected_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index sales_invoices_order_id_live_idx
  on public.sales_invoices(order_id) where status not in ('rejected', 'error');
create unique index sales_invoices_cufe_idx on public.sales_invoices(cufe) where cufe is not null;
create unique index sales_invoices_tenant_prefix_number_idx
  on public.sales_invoices(tenant_id, invoice_prefix, invoice_number) where invoice_number is not null;
create index sales_invoices_tenant_id_idx on public.sales_invoices(tenant_id);
create index sales_invoices_order_id_idx on public.sales_invoices(order_id);

create trigger sales_invoices_set_updated_at before update on public.sales_invoices
  for each row execute function public.set_updated_at();

alter table public.sales_invoices enable row level security;
create policy sales_invoices_select on public.sales_invoices for select
  using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy sales_invoices_insert on public.sales_invoices for insert
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy sales_invoices_update on public.sales_invoices for update
  using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy sales_invoices_delete on public.sales_invoices for delete
  using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
revoke all on public.sales_invoices from anon;

create table public.sales_invoice_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  invoice_id uuid not null references public.sales_invoices(id) on delete cascade,
  order_item_id uuid references public.sales_order_items(id) on delete set null,
  product_name text not null,
  sku text,
  quantity numeric not null default 1,
  unit_price numeric not null default 0,
  subtotal numeric not null default 0,
  tax_type_code text references public.tax_types(code),
  tax_rate numeric not null default 0,
  tax_amount numeric not null default 0,
  taxable_base numeric not null default 0,
  display_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index sales_invoice_items_invoice_id_idx on public.sales_invoice_items(invoice_id);
alter table public.sales_invoice_items enable row level security;
create policy sales_invoice_items_select on public.sales_invoice_items for select
  using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy sales_invoice_items_insert on public.sales_invoice_items for insert
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy sales_invoice_items_update on public.sales_invoice_items for update
  using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy sales_invoice_items_delete on public.sales_invoice_items for delete
  using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
revoke all on public.sales_invoice_items from anon;

-- Retenciones -- estructuralmente separadas de sales_invoice_items.tax_amount
-- porque el UBL de la DIAN las representa en un bloque WithholdingTaxTotal
-- distinto del TaxTotal (confirmado contra el Anexo Técnico), y porque
-- dependen del comprador (clients.applies_withholding), no del producto.
create table public.sales_invoice_withholdings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  invoice_id uuid not null references public.sales_invoices(id) on delete cascade,
  tax_type_code text not null references public.tax_types(code) check (tax_type_code in ('05', '06', '07')),
  concept text,
  rate numeric not null default 0,
  base numeric not null default 0,
  amount numeric not null default 0,
  created_at timestamptz not null default now()
);
create index sales_invoice_withholdings_invoice_id_idx on public.sales_invoice_withholdings(invoice_id);
alter table public.sales_invoice_withholdings enable row level security;
create policy sales_invoice_withholdings_select on public.sales_invoice_withholdings for select
  using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy sales_invoice_withholdings_insert on public.sales_invoice_withholdings for insert
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy sales_invoice_withholdings_update on public.sales_invoice_withholdings for update
  using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy sales_invoice_withholdings_delete on public.sales_invoice_withholdings for delete
  using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
revoke all on public.sales_invoice_withholdings from anon;
