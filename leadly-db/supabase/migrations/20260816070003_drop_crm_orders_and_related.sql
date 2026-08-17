-- Cutover de Contactos + Órdenes, parte 3 -- pedido explícito del usuario
-- (2026-08-16): "elimina crm order y todo lo relacionado con ellas, ajusta
-- el front para que las consuma". El frontend ya migra a sales_orders/
-- sales_order_items/sales_order_payments/sales_order_comments en el mismo
-- momento que esta migración (ver commits de leadly-app).
--
-- Los adjuntos de comentarios de venta (foto en VentaDetalle.tsx) NO se
-- pierden: la tabla `attachments` (nueva, ya existía desde la Fase 3, con
-- columna sales_order_comment_id lista) reemplaza a crm_attachments para
-- ese caso puntual -- crm_attachments sigue intacta, la sigue usando PQR y
-- Tareas exactamente igual que hoy.
--
-- Regresión aceptada (no se arregla acá, es la Fase 5 del roadmap ERP):
-- whatsapp-ai-tools (skill "ventas": create_quote/confirm_quote/cancel_order/
-- etc.) sigue referenciando crm_orders directamente -- ya estaba rota desde
-- que se borró crm_products (no resuelve productos), y ahora además las
-- operaciones sobre pedidos existentes van a fallar con "tabla no existe".

drop trigger trg_crm_orders_confirmed_opportunity on public.crm_orders;
drop function public.apply_order_confirmed_opportunity_effect();

drop trigger trg_crm_orders_set_number on public.crm_orders;
drop function public.set_crm_order_number();

-- crm_attachments.order_comment_id ya no tiene ningún uso vivo (0 filas
-- hoy, ver verificación previa a esta ronda) -- se retira antes de poder
-- borrar crm_order_comments, en favor de attachments.sales_order_comment_id.
alter table public.crm_attachments drop constraint crm_attachments_exactly_one_parent;
alter table public.crm_attachments drop column order_comment_id;
alter table public.crm_attachments add constraint crm_attachments_exactly_one_parent check (
  (case when pqr_id is not null then 1 else 0 end)
  + (case when pqr_update_id is not null then 1 else 0 end)
  + (case when task_id is not null then 1 else 0 end) = 1
);

drop table public.crm_order_payments;
drop table public.crm_order_comments;
drop table public.crm_order_items;
drop table public.crm_orders;
