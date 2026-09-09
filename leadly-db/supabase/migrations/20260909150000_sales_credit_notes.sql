-- Notas crédito electrónicas DIAN sobre una factura ya aceptada -- pedido
-- explícito del usuario 2026-09-09, apenas después de confirmar que el envío
-- de facturas reales a la DIAN ya funciona ("parece funcionar
-- correctamente"). Decisiones cerradas con el usuario:
-- 1. Alcance de v1: el usuario elige un MONTO a acreditar (total o parcial),
--    no un editor de ítems/cantidades -- por eso NO hay una tabla
--    sales_credit_note_items: la nota crédito es una única línea sintética
--    de "ajuste", con impuesto extraído proporcionalmente usando la MISMA
--    tarifa que ya tenía la factura original (columnas tax_type_code/
--    tax_rate directo en esta tabla, no una tabla de líneas aparte).
-- 2. Independiente del módulo "Devoluciones" (returns.sql) -- se emite a
--    mano desde la factura, sin ningún trigger/conexión con ese flujo.
--
-- A diferencia de sales_invoices, esta tabla NO usa un patrón de
-- "attempt_number encadenado por group_id": cada fila es un intento
-- independiente. Un intento que falla (status IN rejected/error) nunca
-- llegó a consumir numeración (esa se asigna recién si la DIAN acepta, ver
-- sendCreditNoteToDian.ts) ni cuenta contra el saldo acreditable de la
-- factura (create_credit_note_attempt solo suma sent/accepted) -- así que
-- reintentar es, sin ninguna mecánica especial, simplemente volver a pedir
-- la creación de una nota nueva por el mismo monto.
create table public.sales_credit_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  invoice_id uuid not null references public.sales_invoices(id) on delete restrict,
  order_id uuid not null references public.sales_orders(id) on delete restrict,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'accepted', 'rejected', 'error')),
  status_detail text,
  -- Códigos DIAN fijos de cac:DiscrepancyResponse/cbc:ResponseCode (tabla
  -- 13.2.4 del Anexo Técnico v1.9, "Caja de Herramientas" -- no vive en la
  -- DB, es una constante replicada en el frontend, mismo criterio que
  -- RETURN_REASONS de returns.sql):
  -- 1 devolución parcial de bienes/servicio, 2 anulación de factura,
  -- 3 rebaja/descuento parcial o total, 4 ajuste de precio, 5 descuento,
  -- 6 otros.
  reason_code text not null check (reason_code in ('1', '2', '3', '4', '5', '6')),
  -- Mínimo 20 caracteres exigido por la DIAN (CBF04, Tam "20..5000") --
  -- replicado acá como defensa en profundidad, la UI ya lo valida antes.
  reason_description text not null check (char_length(reason_description) >= 20),
  credit_note_prefix text,
  credit_note_number bigint,
  currency text not null default 'COP',
  issue_date timestamptz,
  -- Copiados TAL CUAL del buyer_snapshot/seller_snapshot de la factura
  -- original en el momento de crear la nota -- una nota crédito debe
  -- referenciar exactamente la misma identidad de comprador/vendedor que la
  -- factura que corrige, nunca datos re-derivados de clients/tenants tal
  -- como estén hoy (que pueden haber cambiado desde que se facturó).
  buyer_snapshot jsonb not null default '{}'::jsonb,
  seller_snapshot jsonb not null default '{}'::jsonb,
  tax_type_code text references public.tax_types(code),
  tax_rate numeric not null default 0,
  subtotal numeric not null default 0,
  tax_total numeric not null default 0,
  total numeric not null default 0,
  cude text,
  dian_tracking_id text,
  dian_response jsonb,
  sent_at timestamptz,
  accepted_at timestamptz,
  rejected_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index sales_credit_notes_cude_idx on public.sales_credit_notes(cude) where cude is not null;
create unique index sales_credit_notes_tenant_prefix_number_idx
  on public.sales_credit_notes(tenant_id, credit_note_prefix, credit_note_number) where credit_note_number is not null;
create index sales_credit_notes_tenant_id_idx on public.sales_credit_notes(tenant_id);
create index sales_credit_notes_invoice_id_idx on public.sales_credit_notes(invoice_id);
create index sales_credit_notes_order_id_idx on public.sales_credit_notes(order_id);

create trigger sales_credit_notes_set_updated_at before update on public.sales_credit_notes
  for each row execute function public.set_updated_at();

alter table public.sales_credit_notes enable row level security;
create policy sales_credit_notes_select on public.sales_credit_notes for select
  using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy sales_credit_notes_insert on public.sales_credit_notes for insert
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy sales_credit_notes_update on public.sales_credit_notes for update
  using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy sales_credit_notes_delete on public.sales_credit_notes for delete
  using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
revoke all on public.sales_credit_notes from anon;

-- Numeración de notas crédito: a diferencia de las facturas, la DIAN NO
-- exige una resolución autorizada para esto (Anexo Técnico -- el
-- consecutivo lo define el propio contribuyente) -- por eso son solo estas
-- dos columnas sueltas, sin rango/vigencia como resolution_*.
alter table public.tenant_dian_profile add column credit_note_prefix text;
alter table public.tenant_dian_profile add column next_credit_note_number bigint not null default 1;

-- Toda la validación con efecto de concurrencia real (candado sobre la
-- factura + suma de lo ya acreditado + tope contra el total) tiene que
-- pasar en UNA sola transacción de Postgres -- por eso es una función acá y
-- no una secuencia de selects/insert desde la Edge Function (que son
-- llamadas HTTP separadas, cada una su propia transacción implícita: un
-- "for update" en una no protegería nada de una segunda llamada en
-- paralelo). Mismo principio ya aplicado en add_expense_inventory_entry.
create or replace function public.create_credit_note_attempt(
  p_invoice_id uuid,
  p_amount numeric,
  p_reason_code text,
  p_reason_description text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice record;
  v_already_credited numeric;
  v_distinct_rates integer;
  v_tax_type_code text;
  v_tax_rate numeric;
  v_tax_amount numeric;
  v_subtotal numeric;
  v_new_id uuid;
begin
  if not (public.is_superadmin() or public.is_tenant_admin()) then
    raise exception 'Solo un administrador del tenant puede emitir notas crédito.';
  end if;
  if p_reason_code not in ('1', '2', '3', '4', '5', '6') then
    raise exception 'Motivo de nota crédito inválido.';
  end if;
  if char_length(coalesce(p_reason_description, '')) < 20 then
    raise exception 'La descripción del motivo debe tener al menos 20 caracteres.';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto de la nota crédito debe ser mayor a cero.';
  end if;

  select * into v_invoice from public.sales_invoices where id = p_invoice_id for update;
  if v_invoice.id is null then
    raise exception 'Factura no encontrada.';
  end if;
  if not public.is_superadmin() and v_invoice.tenant_id <> public.auth_active_tenant_id() then
    raise exception 'Factura no encontrada.';
  end if;
  if v_invoice.status not in ('sent', 'accepted') then
    raise exception 'Solo se puede emitir una nota crédito sobre una factura aceptada por la DIAN.';
  end if;

  select coalesce(sum(total), 0) into v_already_credited
  from public.sales_credit_notes
  where invoice_id = p_invoice_id and status in ('sent', 'accepted');

  -- Tolerancia de 1 centavo por redondeo -- mismo margen que ya usa
  -- computeLineTax/round2 del lado de queueInvoiceGeneration.ts.
  if v_already_credited + p_amount > v_invoice.total + 0.01 then
    raise exception 'El monto supera el saldo disponible para acreditar de esta factura (saldo: %).',
      to_char(v_invoice.total - v_already_credited, 'FM999999999999990.00');
  end if;

  -- La nota crédito es una única línea de "ajuste" -- solo tiene sentido si
  -- la factura original usa una sola tarifa de impuesto. Si mezcla tarifas
  -- (ej. algunos ítems con IVA 19% y otros con INC), no hay una forma
  -- correcta de repartir un monto global entre ellas -- se rechaza en vez de
  -- adivinar.
  select count(distinct (tax_type_code, tax_rate))
    into v_distinct_rates
  from public.sales_invoice_items
  where invoice_id = p_invoice_id and tax_type_code is not null;
  if v_distinct_rates > 1 then
    raise exception 'Esta factura tiene más de una tarifa de impuesto -- todavía no se puede generar una nota crédito por un monto global sobre ella.';
  end if;

  select tax_type_code, tax_rate into v_tax_type_code, v_tax_rate
  from public.sales_invoice_items
  where invoice_id = p_invoice_id and tax_type_code is not null
  limit 1;
  v_tax_rate := coalesce(v_tax_rate, 0);

  -- El monto ingresado ya incluye el impuesto (mismo criterio que el resto
  -- de la plataforma) -- se extrae, no se suma. Idéntica fórmula a
  -- computeLineTax en queueInvoiceGeneration.ts.
  if v_tax_rate > 0 then
    v_tax_amount := round(p_amount - p_amount / (1 + v_tax_rate / 100), 2);
  else
    v_tax_amount := 0;
  end if;
  v_subtotal := p_amount - v_tax_amount;

  insert into public.sales_credit_notes (
    tenant_id, invoice_id, order_id, status, reason_code, reason_description,
    currency, buyer_snapshot, seller_snapshot, tax_type_code, tax_rate,
    subtotal, tax_total, total, created_by
  ) values (
    v_invoice.tenant_id, p_invoice_id, v_invoice.order_id, 'pending', p_reason_code, p_reason_description,
    v_invoice.currency, v_invoice.buyer_snapshot, v_invoice.seller_snapshot, v_tax_type_code, v_tax_rate,
    v_subtotal, v_tax_amount, p_amount, auth.uid()
  ) returning id into v_new_id;

  return v_new_id;
end;
$$;

revoke all on function public.create_credit_note_attempt(uuid, numeric, text, text) from public;
grant execute on function public.create_credit_note_attempt(uuid, numeric, text, text) to authenticated;
