-- El diseño explícito (ver applyDianVerdict.ts, "un intento rechazado libera
-- ese mismo número para el próximo intento real, en vez de quemarlo") nunca
-- se reflejó en el índice único: `sales_invoices_tenant_prefix_number_idx`/
-- `sales_credit_notes_tenant_prefix_number_idx` bloqueaban CUALQUIER
-- duplicado de número, incluso contra una fila ya 'rejected'/'error'. Bug
-- real encontrado en vivo 2026-09-10 (postgres_logs: "duplicate key value
-- violates unique constraint sales_invoices_tenant_prefix_number_idx") --
-- el segundo intento de reenvío de una factura rechazada chocaba contra el
-- número que el intento anterior ya había grabado, y como el código de
-- sendInvoiceToDian.ts no revisaba el error de ese UPDATE, la falla quedaba
-- invisible: la factura se mandaba y la DIAN respondía de verdad, pero
-- cufe/dian_tracking_id/sent_at nunca se guardaban antes de aplicar el
-- veredicto (rejected sí se escribía, porque ese campo no choca).
drop index if exists sales_invoices_tenant_prefix_number_idx;
create unique index sales_invoices_tenant_prefix_number_idx
  on sales_invoices (tenant_id, invoice_prefix, invoice_number)
  where invoice_number is not null and status not in ('rejected', 'error');

drop index if exists sales_credit_notes_tenant_prefix_number_idx;
create unique index sales_credit_notes_tenant_prefix_number_idx
  on sales_credit_notes (tenant_id, credit_note_prefix, credit_note_number)
  where credit_note_number is not null and status not in ('rejected', 'error');
