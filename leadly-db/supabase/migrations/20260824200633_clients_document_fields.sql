-- Aurora (skill nueva "clientes") necesita poder confirmar/guardar el
-- documento de identidad del contacto de una conversación -- clients no
-- tenía ningún campo de cédula/NIT personal (solo `nit`, pensado para
-- empresas, y `tax_id` vive en contact_addresses, por dirección, no por
-- cliente). Mismo patrón que tenants.document_type/document_number.

alter table public.clients add column document_type text;
alter table public.clients add column document_number text;

-- Evita que dos conversaciones distintas (ej. el mismo cliente escribiendo
-- desde un número nuevo) terminen creando dos fichas separadas con el mismo
-- documento -- parcial porque la mayoría de contactos hoy no tienen
-- documento cargado todavía (backfill vacío, se completa conversacionalmente
-- de acá en más).
create unique index clients_tenant_document_number_idx
  on public.clients(tenant_id, document_number)
  where document_number is not null and deleted_at is null;
