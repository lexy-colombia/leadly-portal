-- Le da a la IA de WhatsApp acceso a las dos secciones nuevas del detalle
-- de venta (Pagos y Comentarios, ver VentaDetalle.tsx) -- hasta ahora
-- add_quote_note escribía en crm_orders.notes (un solo campo de texto, sin
-- historial ni autor), un workaround de cuando crm_order_comments todavía no
-- existía. Ahora que sí existe (bitácora con autor/fecha, visible en la
-- sección "Comentarios"), es el lugar correcto para lo que escribe la IA --
-- mismo criterio que crm_notes.created_by_ai para distinguir en la UI lo que
-- escribió la IA de lo que escribió un agente humano.
alter table public.crm_order_comments add column created_by_ai boolean not null default false;
alter table public.crm_order_payments add column created_by_ai boolean not null default false;
