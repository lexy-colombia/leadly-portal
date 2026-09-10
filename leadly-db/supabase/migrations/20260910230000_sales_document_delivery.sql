-- Entrega de documentos electrónicos al adquiriente por correo, y
-- conservación del XML firmado que se transmitió a la DIAN.
--
-- Dos huecos reales que esta migración cierra:
--
-- 1. El XML firmado se construía, se mandaba a la DIAN y se DESCARTABA.
--    `sales_invoices.xml_storage_path` existía desde el 2026-09-03 (y hasta
--    estaba en los tipos de TypeScript) pero ningún código lo escribía
--    nunca. El documento electrónico de generación es justamente el que el
--    facturador debe conservar y el que el Anexo Técnico (numeral 9.3)
--    admite entregar al adquiriente -- sin guardarlo no hay nada que
--    adjuntar ni que auditar después.
-- 2. No había forma de entregar el documento al adquiriente, que es un
--    requisito, no una comodidad: el numeral 9.3 lista el correo
--    electrónico como uno de los medios autorizados de entrega.
--
-- El bucket es PRIVADO (mismo criterio que tenant-certificates y
-- crm-attachments, y a diferencia de tenant-logos): una factura trae datos
-- fiscales de un tercero identificado, no se sirve por URL pública. El
-- adjunto del correo viaja como bytes en el propio mensaje, nunca como un
-- link firmado que pueda reenviarse a cualquiera.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sales-documents', 'sales-documents', false, 5242880,
        array['application/xml', 'text/xml'])
on conflict (id) do nothing;

-- Lectura para cualquier miembro del tenant dueño (ver la factura es parte
-- de ver el pedido, mismo criterio que sales-invoice-pdf). La ESCRITURA no
-- tiene policy a propósito: el único que sube acá es el pipeline de envío
-- con el service role, que se salta RLS -- ningún usuario debe poder
-- inyectar a mano un XML "firmado" en el expediente fiscal de su tenant.
-- Tampoco hay update ni delete: el XML transmitido es inmutable, igual que
-- el intento de factura que lo generó.
create policy sales_documents_read on storage.objects for select using (
  bucket_id = 'sales-documents'
  and (public.is_superadmin() or (storage.foldername(name))[1] = public.auth_active_tenant_id()::text)
);

-- Las notas crédito no tenían dónde guardar su XML -- la factura sí tenía
-- la columna (sin usar), esta no la tenía ni declarada.
alter table public.sales_credit_notes add column if not exists xml_storage_path text;

-- Bitácora de entregas. Append-only a propósito (solo select/insert, mismo
-- criterio que stock_movements y expense_inventory_entries): "le entregamos
-- este documento a este correo tal día" es evidencia de cumplimiento del
-- numeral 9.3, no un registro editable. Un reenvío es una fila NUEVA, nunca
-- una edición de la anterior -- igual que un reintento de factura es un
-- attempt_number nuevo y no una edición del rechazado.
create table public.sales_document_emails (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  -- Exactamente uno de los dos: el mismo documento no puede ser factura y
  -- nota crédito a la vez.
  invoice_id uuid references public.sales_invoices(id) on delete cascade,
  credit_note_id uuid references public.sales_credit_notes(id) on delete cascade,
  constraint sales_document_emails_one_target check (
    (invoice_id is not null and credit_note_id is null)
    or (invoice_id is null and credit_note_id is not null)
  ),
  recipient text not null,
  subject text not null,
  -- 'sent': el proveedor aceptó el mensaje. NO significa que el adquiriente
  -- lo haya leído ni que su servidor lo haya aceptado -- un rebote posterior
  -- no se entera acá (haría falta el webhook de Resend, fuera de alcance).
  status text not null check (status in ('sent', 'error')),
  provider text not null default 'resend',
  provider_message_id text,
  error_detail text,
  -- Nombres de archivo realmente adjuntados, para poder responder "¿se le
  -- mandó el XML o solo el PDF?" sin reconstruir nada.
  attachments text[] not null default '{}',
  -- 'auto': salió solo al aceptar la DIAN. 'manual': alguien tocó
  -- "Reenviar" (created_by dice quién).
  triggered_by text not null check (triggered_by in ('auto', 'manual')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index sales_document_emails_invoice_id_idx on public.sales_document_emails(invoice_id) where invoice_id is not null;
create index sales_document_emails_credit_note_id_idx on public.sales_document_emails(credit_note_id) where credit_note_id is not null;
create index sales_document_emails_tenant_id_idx on public.sales_document_emails(tenant_id);

alter table public.sales_document_emails enable row level security;

create policy sales_document_emails_select on public.sales_document_emails for select using (
  public.is_superadmin() or tenant_id = public.auth_active_tenant_id()
);
-- Insert abierto al propio tenant (no solo service_role) porque el reenvío
-- manual se dispara con el JWT del usuario a través de dian-submit, que sí
-- escribe con admin client -- pero dejar la policy permite auditar/insertar
-- desde el portal si alguna vez hace falta, sin poder tocar filas viejas.
create policy sales_document_emails_insert on public.sales_document_emails for insert with check (
  public.is_superadmin() or tenant_id = public.auth_active_tenant_id()
);
